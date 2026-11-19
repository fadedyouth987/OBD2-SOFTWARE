//! ISO 14230-2 (KWP2000 on K-line), tester side (Task 1.2).
//!
//! - Message framing: format byte (address mode + length, or a separate
//!   length byte for > 63 data bytes), target, source, data, checksum.
//! - [`KLineLink`]: over a byte-level [`KLineAdapter`], with fast init
//!   (StartCommunication 0x81) or 5-baud init, P3min between the ECU's answer
//!   and the next request, and optional P4 gaps between request bytes.
//! - [`ElmKLineLink`]: over an STN/ELM chip, which does the framing and the
//!   bus init itself; we verify what it reports.
//!
//! Independent of the simulator's framing (`sim::kline_peer`).

use std::{collections::VecDeque, time::Duration};

use async_trait::async_trait;
use tokio::time::{sleep, Instant};

use super::{Link, Timing};
use crate::hal::{
    serial::SerialLink, stn_elm::StnElmAdapter, HalError, KLineAdapter, KeyBytes, Result,
};

/// Usual tester address on K-line.
pub const TESTER: u8 = 0xF1;

/// Builds a physically addressed request message.
pub fn build_message(target: u8, source: u8, data: &[u8]) -> Vec<u8> {
    let mut out = if data.len() <= 0x3F {
        vec![0x80 | data.len() as u8, target, source]
    } else {
        vec![0x80, target, source, data.len() as u8]
    };
    out.extend_from_slice(data);
    let sum = out.iter().fold(0u8, |a, b| a.wrapping_add(*b));
    out.push(sum);
    out
}

/// A parsed message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub target: Option<u8>,
    pub source: Option<u8>,
    pub data: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Parse {
    /// A message and the number of bytes it used.
    Done(Message, usize),
    NeedMore,
    /// Not a valid message start; drop one byte and retry.
    Garbage,
}

/// Parses the start of `buf`. Supports addressed (0x80/0xC0) and
/// address-less (0x00) formats, with or without a length byte.
pub fn parse_message(buf: &[u8]) -> Parse {
    let Some(&fmt) = buf.first() else {
        return Parse::NeedMore;
    };
    let addressed = match fmt & 0xC0 {
        0x80 | 0xC0 => true,
        0x00 => false,
        _ => return Parse::Garbage, // 0x40: CARB mode, not used
    };
    let addr_len = if addressed { 2 } else { 0 };
    let (len, header) = if fmt & 0x3F == 0 {
        match buf.get(1 + addr_len) {
            Some(&l) => (usize::from(l), 2 + addr_len),
            None => return Parse::NeedMore,
        }
    } else {
        (usize::from(fmt & 0x3F), 1 + addr_len)
    };
    if len == 0 {
        return Parse::Garbage;
    }
    let total = header + len + 1;
    if buf.len() < total {
        return Parse::NeedMore;
    }
    if buf[..total - 1].iter().fold(0u8, |a, b| a.wrapping_add(*b)) != buf[total - 1] {
        return Parse::Garbage;
    }
    let message = Message {
        target: addressed.then(|| buf[1]),
        source: addressed.then(|| buf[2]),
        data: buf[header..header + len].to_vec(),
    };
    Parse::Done(message, total)
}

/// ISO 14230 session with one ECU over a K-line adapter.
pub struct KLineLink<A: KLineAdapter> {
    adapter: A,
    target: u8,
    tester: u8,
    timing: Timing,
    last_rx: Option<Instant>,
    buf: Vec<u8>,
}

impl<A: KLineAdapter> KLineLink<A> {
    fn wrap(adapter: A, target: u8, timing: Timing) -> Self {
        Self {
            adapter,
            target,
            tester: TESTER,
            timing,
            last_rx: None,
            buf: Vec::new(),
        }
    }

    /// Fast init, then StartCommunication (0x81) to `target`. The adapter must be open.
    pub async fn connect_fast(
        mut adapter: A,
        target: u8,
        timing: Timing,
    ) -> Result<(Self, KeyBytes)> {
        adapter.wake_fast_init().await?;
        let mut link = Self::wrap(adapter, target, timing);
        link.send_message(&[0x81]).await?;
        let resp = link.recv_message(timing.p2 * 4).await?;
        match resp.as_slice() {
            [0xC1, kb1, kb2, ..] => Ok((
                link,
                KeyBytes {
                    kb1: *kb1,
                    kb2: *kb2,
                },
            )),
            other => Err(HalError::Protocol(format!(
                "StartCommunication refused: {other:02X?}"
            ))),
        }
    }

    /// 5-baud init to `target` (key bytes from the adapter's handshake).
    pub async fn connect_5baud(
        mut adapter: A,
        target: u8,
        timing: Timing,
    ) -> Result<(Self, KeyBytes)> {
        let kb = adapter.wake_5baud(target).await?;
        let mut link = Self::wrap(adapter, target, timing);
        link.last_rx = Some(Instant::now());
        Ok((link, kb))
    }

    pub fn adapter(&self) -> &A {
        &self.adapter
    }

    pub fn target(&self) -> u8 {
        self.target
    }

    async fn send_message(&mut self, data: &[u8]) -> Result<()> {
        if data.is_empty() || data.len() > 255 {
            return Err(HalError::InvalidFrame(format!(
                "K-line message of {} bytes",
                data.len()
            )));
        }
        if let Some(last) = self.last_rx {
            let ready = last + self.timing.p3_min;
            if Instant::now() < ready {
                sleep(ready - Instant::now()).await; // P3min
            }
        }
        let bytes = build_message(self.target, self.tester, data);
        if self.timing.p4.is_zero() {
            self.adapter.write_bytes(&bytes).await?;
        } else {
            for (i, b) in bytes.iter().enumerate() {
                if i > 0 {
                    sleep(self.timing.p4).await;
                }
                self.adapter.write_bytes(&[*b]).await?;
            }
        }
        self.buf.clear();
        Ok(())
    }

    async fn recv_message(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        loop {
            match parse_message(&self.buf) {
                Parse::Done(msg, used) => {
                    self.buf.drain(..used);
                    self.last_rx = Some(Instant::now());
                    let from_target = msg.source.is_none_or(|s| s == self.target);
                    let to_us = msg.target.is_none_or(|t| t == self.tester);
                    if from_target && to_us {
                        return Ok(msg.data);
                    }
                    continue;
                }
                Parse::Garbage => {
                    self.buf.remove(0);
                    continue;
                }
                Parse::NeedMore => {}
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(timeout));
            }
            match self.adapter.read_bytes(260, left).await {
                Ok(bytes) => self.buf.extend(bytes),
                Err(HalError::Timeout(_)) => return Err(HalError::Timeout(timeout)),
                Err(e) => return Err(e),
            }
        }
    }
}

#[async_trait]
impl<A: KLineAdapter> Link for KLineLink<A> {
    async fn send_pdu(&mut self, data: &[u8]) -> Result<()> {
        self.send_message(data).await
    }

    async fn recv_pdu(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        self.recv_message(timeout).await
    }

    fn ids(&self) -> (u32, u32) {
        (u32::from(self.target), u32::from(self.tester))
    }

    fn timing(&self) -> Timing {
        self.timing
    }
}

/// K-line session through an STN/ELM chip (ELM-framed messages).
pub struct ElmKLineLink<L: SerialLink> {
    adapter: StnElmAdapter<L>,
    header: [u8; 3],
    target: u8,
    queue: VecDeque<Vec<u8>>,
}

impl<L: SerialLink> ElmKLineLink<L> {
    /// `adapter` must already be initialized (`StnElmAdapter::init`) for a
    /// K-line protocol. The chip performs the bus init on the first request.
    pub fn new(adapter: StnElmAdapter<L>, target: u8) -> Self {
        Self {
            adapter,
            header: [0x80, target, TESTER],
            target,
            queue: VecDeque::new(),
        }
    }

    pub fn adapter(&self) -> &StnElmAdapter<L> {
        &self.adapter
    }
}

#[async_trait]
impl<L: SerialLink> Link for ElmKLineLink<L> {
    async fn send_pdu(&mut self, data: &[u8]) -> Result<()> {
        let messages = self.adapter.request_message(&self.header, data).await?;
        self.queue = messages
            .into_iter()
            .filter(|m| m.header.get(2).is_none_or(|src| *src == self.target))
            .map(|m| m.data)
            .collect();
        Ok(())
    }

    async fn recv_pdu(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        // The chip only listens while a command runs; it already reported everything.
        self.queue.pop_front().ok_or(HalError::Timeout(timeout))
    }

    fn ids(&self) -> (u32, u32) {
        (u32::from(self.target), u32::from(TESTER))
    }

    fn timing(&self) -> Timing {
        Timing::KLINE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{hal::virtual_kline::VirtualKLineAdapter, sim::profiles::e90_pre2007};

    #[test]
    fn framing_round_trip() {
        assert_eq!(
            build_message(0x12, 0xF1, &[0x81]),
            vec![0x81, 0x12, 0xF1, 0x81, 0x05]
        );
        let long = build_message(0x12, 0xF1, &[0x31; 70]);
        assert_eq!((long[0], long[3]), (0x80, 70));
        match parse_message(&long) {
            Parse::Done(m, used) => {
                assert_eq!((m.target, m.data.len(), used), (Some(0x12), 70, long.len()))
            }
            other => panic!("{other:?}"),
        }
        // Address-less format: 0x02 len, data, checksum.
        assert_eq!(
            parse_message(&[0x02, 0x7E, 0x00, 0x80]),
            Parse::Done(
                Message {
                    target: None,
                    source: None,
                    data: vec![0x7E, 0x00]
                },
                4
            )
        );
        assert_eq!(parse_message(&[0x83, 0xF1]), Parse::NeedMore);
        assert_eq!(
            parse_message(&[0x81, 0x12, 0xF1, 0x81, 0x00]),
            Parse::Garbage
        );
        assert_eq!(parse_message(&[0x40]), Parse::Garbage);
    }

    #[tokio::test(start_paused = true)]
    async fn p3_min_is_respected_between_exchanges() {
        let mut adapter = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        adapter.open(10_400).await.unwrap();
        let (mut link, kb) = KLineLink::connect_fast(adapter, e90_pre2007::DME, Timing::KLINE)
            .await
            .unwrap();
        assert_eq!(
            kb,
            KeyBytes {
                kb1: 0xEF,
                kb2: 0x8F
            }
        );
        let received = link.last_rx.unwrap();
        link.send_message(&[0x3E]).await.unwrap();
        assert!(Instant::now() - received >= Timing::KLINE.p3_min);
        assert_eq!(
            link.recv_message(Duration::from_millis(200)).await.unwrap(),
            vec![0x7E]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn start_communication_to_missing_ecu_times_out() {
        let mut adapter = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        adapter.open(10_400).await.unwrap();
        assert!(matches!(
            KLineLink::connect_fast(adapter, 0x77, Timing::KLINE).await,
            Err(HalError::Timeout(_))
        ));
    }
}
