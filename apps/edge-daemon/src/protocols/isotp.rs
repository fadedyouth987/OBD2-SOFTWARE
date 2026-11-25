//! Tester side of ISO 15765-2 (ISO-TP) over any [`VehicleBusAdapter`] (Task 1.2).
//!
//! - Single Frame (0x0), First Frame (0x1), Consecutive Frame (0x2), Flow
//!   Control (0x3), messages up to 4,095 bytes.
//! - Sending: waits for the ECU's Flow Control after the First Frame and after
//!   every block, honouring its BlockSize and STmin, and WAIT/overflow status.
//! - Receiving: answers a First Frame with our Flow Control (configurable BS
//!   and STmin) and sends a new one after each block; checks sequence numbers.
//! - Normal and BMW extended addressing ([`CanAddressing`]).
//!
//! Independent of the simulator's ECU-side peer (`sim::isotp_peer`), so the
//! two implementations check each other.

use std::time::Duration;

use async_trait::async_trait;
use tokio::time::Instant;

use super::{addressing::CanAddressing, Link, Timing};
use crate::{
    hal::{CanFrame, HalError, Result, VehicleBusAdapter},
    sim::isotp_peer::stmin_us,
};

/// Largest ISO-TP message without the 32-bit length escape.
pub const MAX_MESSAGE: usize = 4_095;

/// Tester-side ISO-TP parameters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct IsoTpConfig {
    /// BlockSize we ask the ECU for (0 = no further Flow Control).
    pub block_size: u8,
    /// STmin we ask the ECU for (ISO 15765-2 encoding).
    pub st_min: u8,
    /// Pad frames to 8 bytes with this value (most ECUs require padding).
    pub pad: Option<u8>,
    /// N_Bs: how long to wait for the ECU's Flow Control.
    pub n_bs: Duration,
    /// N_Cr: how long to wait for each Consecutive Frame.
    pub n_cr: Duration,
    /// Flow Control WAIT frames tolerated before giving up (N_WFTmax).
    pub max_wait_frames: u8,
}

impl Default for IsoTpConfig {
    fn default() -> Self {
        Self {
            block_size: 0,
            st_min: 0,
            pad: Some(0xAA),
            n_bs: Duration::from_millis(1_000),
            n_cr: Duration::from_millis(1_000),
            max_wait_frames: 10,
        }
    }
}

/// ISO-TP connection to one ECU.
pub struct IsoTpLink<A: VehicleBusAdapter> {
    adapter: A,
    addr: CanAddressing,
    cfg: IsoTpConfig,
    timing: Timing,
}

impl<A: VehicleBusAdapter> IsoTpLink<A> {
    /// Takes an open adapter and installs the response filter.
    pub async fn new(mut adapter: A, addr: CanAddressing, cfg: IsoTpConfig) -> Result<Self> {
        adapter.set_filter(&[addr.rx_filter()]).await?;
        Ok(Self {
            adapter,
            addr,
            cfg,
            timing: Timing::CAN,
        })
    }

    pub fn with_timing(mut self, timing: Timing) -> Self {
        self.timing = timing;
        self
    }

    pub fn adapter(&self) -> &A {
        &self.adapter
    }

    pub fn into_adapter(self) -> A {
        self.adapter
    }

    fn room(&self) -> usize {
        7 - usize::from(self.addr.tx_prefix().is_some())
    }

    fn frame(&self, body: &[u8]) -> Result<CanFrame> {
        self.frame_to(self.addr.tx_id(), body)
    }

    fn frame_to(&self, id: u32, body: &[u8]) -> Result<CanFrame> {
        let mut data = Vec::with_capacity(8);
        data.extend(self.addr.tx_prefix());
        data.extend_from_slice(body);
        if let Some(pad) = self.cfg.pad {
            data.resize(8, pad);
        }
        CanFrame::new(id, self.addr.is_extended(), &data)
    }

    /// Next frame from the ECU (address byte removed), within `timeout`.
    async fn recv_raw(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(timeout));
            }
            let frame = match self.adapter.recv_frame(left).await {
                Err(HalError::Timeout(_)) => return Err(HalError::Timeout(timeout)),
                other => other?,
            };
            if frame.id() != self.addr.rx_id() || frame.is_extended() != self.addr.is_extended() {
                continue;
            }
            match self.addr.rx_prefix() {
                Some(p) if frame.data().first() == Some(&p) => {
                    return Ok(frame.data()[1..].to_vec())
                }
                Some(_) => continue,
                None => return Ok(frame.data().to_vec()),
            }
        }
    }

    async fn send_flow_control(&mut self) -> Result<()> {
        let fc = self.frame_to(
            self.addr.flow_control_id(),
            &[0x30, self.cfg.block_size, self.cfg.st_min],
        )?;
        self.adapter.send_frame(&fc).await
    }

    /// Sends one message, segmenting it as needed.
    async fn send_message(&mut self, data: &[u8]) -> Result<()> {
        if data.is_empty() || data.len() > MAX_MESSAGE {
            return Err(HalError::InvalidFrame(format!(
                "ISO-TP message of {} bytes",
                data.len()
            )));
        }
        let room = self.room();
        if data.len() <= room {
            let mut body = vec![data.len() as u8];
            body.extend_from_slice(data);
            let sf = self.frame(&body)?;
            return self.adapter.send_frame(&sf).await;
        }
        let first = room - 1;
        let mut body = vec![0x10 | (data.len() >> 8) as u8, data.len() as u8];
        body.extend_from_slice(&data[..first]);
        let ff = self.frame(&body)?;
        self.adapter.send_frame(&ff).await?;

        let mut offset = first;
        let mut sn: u8 = 1;
        let mut waits = 0u8;
        while offset < data.len() {
            // Wait for the ECU's Flow Control.
            let n_bs = self.cfg.n_bs;
            let fc = loop {
                let pdu = self.recv_raw(n_bs).await.map_err(|e| match e {
                    HalError::Timeout(_) => {
                        HalError::Protocol("ISO-TP: no Flow Control from the ECU (N_Bs)".into())
                    }
                    other => other,
                })?;
                if pdu.first().is_some_and(|pci| pci >> 4 == 0x3) && pdu.len() >= 3 {
                    break pdu;
                }
            };
            match fc[0] & 0x0F {
                0x0 => {}
                0x1 => {
                    waits += 1;
                    if waits > self.cfg.max_wait_frames {
                        return Err(HalError::Protocol(
                            "ISO-TP: too many Flow Control WAIT frames".into(),
                        ));
                    }
                    continue;
                }
                0x2 => {
                    return Err(HalError::Protocol(
                        "ISO-TP: ECU reported buffer overflow".into(),
                    ))
                }
                other => {
                    return Err(HalError::Protocol(format!(
                        "ISO-TP: invalid Flow Control status {other:#X}"
                    )))
                }
            }
            let (block_size, gap) = (fc[1], Duration::from_micros(stmin_us(fc[2])));
            let mut sent = 0u16;
            while offset < data.len() && (block_size == 0 || sent < u16::from(block_size)) {
                if sent > 0 && !gap.is_zero() {
                    tokio::time::sleep(gap).await;
                }
                let end = (offset + room).min(data.len());
                let mut body = vec![0x20 | sn];
                body.extend_from_slice(&data[offset..end]);
                let cf = self.frame(&body)?;
                self.adapter.send_frame(&cf).await?;
                offset = end;
                sn = (sn + 1) & 0x0F;
                sent += 1;
            }
        }
        Ok(())
    }

    /// Receives one message, sending Flow Control as needed.
    async fn recv_message(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(timeout));
            }
            let pdu = match self.recv_raw(left).await {
                Err(HalError::Timeout(_)) => return Err(HalError::Timeout(timeout)),
                other => other?,
            };
            let Some(&pci) = pdu.first() else { continue };
            match pci >> 4 {
                0x0 => {
                    let len = usize::from(pci & 0x0F);
                    if len == 0 || len >= pdu.len() {
                        continue; // malformed Single Frame
                    }
                    return Ok(pdu[1..=len].to_vec());
                }
                0x1 if pdu.len() >= 2 => {
                    let len = (usize::from(pci & 0x0F) << 8) | usize::from(pdu[1]);
                    return self.receive_segmented(len, &pdu[2..]).await;
                }
                _ => continue, // stray CF/FC from an earlier exchange
            }
        }
    }

    async fn receive_segmented(&mut self, len: usize, first: &[u8]) -> Result<Vec<u8>> {
        let mut data = first.to_vec();
        let mut next_sn: u8 = 1;
        let mut in_block = 0u16;
        self.send_flow_control().await?;
        while data.len() < len {
            let pdu = self.recv_raw(self.cfg.n_cr).await.map_err(|e| match e {
                HalError::Timeout(_) => {
                    HalError::Protocol("ISO-TP: Consecutive Frame timeout (N_Cr)".into())
                }
                other => other,
            })?;
            let Some(&pci) = pdu.first() else { continue };
            if pci >> 4 != 0x2 {
                continue;
            }
            if pci & 0x0F != next_sn {
                return Err(HalError::Protocol(format!(
                    "ISO-TP: sequence number {:X}, expected {next_sn:X}",
                    pci & 0x0F
                )));
            }
            data.extend_from_slice(&pdu[1..]);
            next_sn = (next_sn + 1) & 0x0F;
            in_block += 1;
            if self.cfg.block_size != 0
                && in_block == u16::from(self.cfg.block_size)
                && data.len() < len
            {
                in_block = 0;
                self.send_flow_control().await?;
            }
        }
        data.truncate(len);
        Ok(data)
    }
}

#[async_trait]
impl<A: VehicleBusAdapter> Link for IsoTpLink<A> {
    async fn drain(&mut self) {
        for _ in 0..1_024 {
            if self.adapter.recv_frame(Duration::ZERO).await.is_err() {
                break;
            }
        }
    }

    async fn send_pdu(&mut self, data: &[u8]) -> Result<()> {
        self.send_message(data).await
    }

    async fn recv_pdu(&mut self, timeout: Duration) -> Result<Vec<u8>> {
        self.recv_message(timeout).await
    }

    fn ids(&self) -> (u32, u32) {
        self.addr.token_ids()
    }

    fn timing(&self) -> Timing {
        self.timing
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        hal::{virtual_bus::VirtualBus, CanFilter},
        sim::profiles::generic_uds,
    };

    const T: Duration = Duration::from_millis(500);

    /// A tester and a hand-driven "ECU" adapter on one bus.
    async fn pair() -> (
        IsoTpLink<crate::hal::virtual_bus::VirtualBusAdapter>,
        crate::hal::virtual_bus::VirtualBusAdapter,
    ) {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut tester = bus.adapter();
        let mut ecu = bus.adapter();
        tester.open(500_000).await.unwrap();
        ecu.open(500_000).await.unwrap();
        // Use ids no simulated ECU answers on.
        ecu.set_filter(&[CanFilter::exact(0x740, false)])
            .await
            .unwrap();
        let link = IsoTpLink::new(
            tester,
            CanAddressing::normal(0x740, 0x748),
            IsoTpConfig::default(),
        )
        .await
        .unwrap();
        (link, ecu)
    }

    /// Task 1.2 gate (send side): a > 64-byte message honours the ECU's BS and STmin.
    #[tokio::test(start_paused = true)]
    async fn send_honours_ecu_block_size_and_stmin() {
        let (mut link, mut ecu) = pair().await;
        let message: Vec<u8> = (0..100u8).collect();
        let sender = tokio::spawn(async move {
            link.send_message(&message).await.unwrap();
            link
        });
        let ff = ecu.recv_frame(T).await.unwrap();
        assert_eq!(&ff.data()[..2], &[0x10, 100]);
        let mut got = ff.data()[2..].to_vec();
        let mut times = Vec::new();
        // BS 4, STmin 10 ms; a fresh FC after each block of four.
        let mut fcs = 0;
        while got.len() < 100 {
            ecu.send_frame(&CanFrame::std(0x748, &[0x30, 0x04, 0x0A, 0, 0, 0, 0, 0]))
                .await
                .unwrap();
            fcs += 1;
            for _ in 0..4 {
                if got.len() >= 100 {
                    break;
                }
                let cf = ecu.recv_frame(T).await.unwrap();
                times.push(Instant::now());
                got.extend_from_slice(&cf.data()[1..]);
            }
            // Nothing more until the next Flow Control.
            if got.len() < 100 {
                assert!(
                    ecu.recv_frame(Duration::from_millis(50)).await.is_err(),
                    "sender waited for FC"
                );
            }
        }
        sender.await.unwrap();
        got.truncate(100);
        assert_eq!(got, (0..100u8).collect::<Vec<_>>());
        assert_eq!(
            fcs, 4,
            "94 bytes after the FF = 14 CFs = 4 blocks of up to 4"
        );
        for pair in times.chunks(4) {
            for w in pair.windows(2) {
                assert!(
                    w[1] - w[0] >= Duration::from_millis(10),
                    "STmin honoured inside a block"
                );
            }
        }
    }

    /// Task 1.2 gate (receive side): a > 64-byte response with our BS/STmin.
    #[tokio::test(start_paused = true)]
    async fn receive_sends_flow_control_per_block() {
        let (mut link, mut ecu) = pair().await;
        link.cfg.block_size = 3;
        link.cfg.st_min = 0x05;
        let receiver = tokio::spawn(async move { link.recv_message(T).await });
        let message: Vec<u8> = (0..80u8).map(|b| b ^ 0x5A).collect();
        // ECU side, by hand: FF, then CFs in blocks of 3 after each FC.
        let mut ff = vec![0x10, 80];
        ff.extend_from_slice(&message[..6]);
        ecu.send_frame(&CanFrame::std(0x748, &ff)).await.unwrap();
        let mut offset = 6;
        let mut sn = 1u8;
        let mut fcs = 0;
        while offset < 80 {
            let fc = ecu.recv_frame(T).await.unwrap();
            assert_eq!(&fc.data()[..3], &[0x30, 0x03, 0x05]);
            fcs += 1;
            for _ in 0..3 {
                if offset >= 80 {
                    break;
                }
                let end = (offset + 7).min(80);
                let mut cf = vec![0x20 | sn];
                cf.extend_from_slice(&message[offset..end]);
                ecu.send_frame(&CanFrame::std(0x748, &cf)).await.unwrap();
                offset = end;
                sn = (sn + 1) & 0x0F;
            }
        }
        assert_eq!(receiver.await.unwrap().unwrap(), message);
        assert_eq!(fcs, 4, "74 bytes after the FF = 11 CFs = 4 blocks of 3");
    }

    #[tokio::test(start_paused = true)]
    async fn sequence_errors_and_overflow_are_reported() {
        let (mut link, mut ecu) = pair().await;
        let receiver = tokio::spawn(async move {
            let r = link.recv_message(T).await;
            (link, r)
        });
        ecu.send_frame(&CanFrame::std(0x748, &[0x10, 0x10, 1, 2, 3, 4, 5, 6]))
            .await
            .unwrap();
        ecu.recv_frame(T).await.unwrap(); // our FC
        ecu.send_frame(&CanFrame::std(0x748, &[0x22, 7, 8, 9, 10, 11, 12, 13]))
            .await
            .unwrap();
        let (mut link, result) = receiver.await.unwrap();
        assert!(matches!(result, Err(HalError::Protocol(m)) if m.contains("sequence")));

        let sender = tokio::spawn(async move { link.send_message(&[0u8; 20]).await });
        ecu.recv_frame(T).await.unwrap(); // FF
        ecu.send_frame(&CanFrame::std(0x748, &[0x32, 0, 0, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        assert!(
            matches!(sender.await.unwrap(), Err(HalError::Protocol(m)) if m.contains("overflow"))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn missing_flow_control_times_out() {
        let (mut link, _ecu) = pair().await;
        assert!(
            matches!(link.send_message(&[0u8; 20]).await, Err(HalError::Protocol(m)) if m.contains("N_Bs"))
        );
        assert!(link.send_message(&[]).await.is_err());
        assert!(link.send_message(&[0u8; 4_096]).await.is_err());
    }
}
