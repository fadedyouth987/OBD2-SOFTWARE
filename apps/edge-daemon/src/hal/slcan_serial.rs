//! SLCAN (LAWICEL ASCII) adapter: Flipper Zero USB-UART CAN apps, MCP2515
//! SLCAN bridges, CANable in SLCAN mode (Task 1.1).
//!
//! Commands used: `C` close, `Sn` bitrate, `O` open, `tIIILDD..` send 11-bit,
//! `TIIIIIIIILDD..` send 29-bit. Devices answer `\r` (OK), `z\r`/`Z\r`
//! (transmit OK) or BEL `\x07` (error), and report received frames as
//! `t...`/`T...` lines, optionally followed by a 4-digit timestamp.
//! Acceptance filtering is done in software: SLCAN's `M`/`m` registers are
//! SJA1000-specific and not implemented by most clones.

use std::{collections::VecDeque, time::Duration};

use async_trait::async_trait;
use tokio::time::Instant;

use super::{
    parse_hex, passes, serial::SerialLink, to_hex, CanFilter, CanFrame, HalError, Result,
    VehicleBusAdapter, SLCAN_BITRATES,
};

const ACK_TIMEOUT: Duration = Duration::from_millis(200);
const BEL: u8 = 0x07;

/// Encodes a frame as an SLCAN transmit command (with the trailing `\r`).
pub fn encode_frame(frame: &CanFrame) -> String {
    if frame.is_extended() {
        format!(
            "T{:08X}{}{}\r",
            frame.id(),
            frame.dlc(),
            to_hex(frame.data())
        )
    } else {
        format!(
            "t{:03X}{}{}\r",
            frame.id(),
            frame.dlc(),
            to_hex(frame.data())
        )
    }
}

/// Parses one received line (without `\r`). Remote frames (`r`/`R`) yield `None`.
pub fn parse_frame_line(line: &str) -> Result<Option<CanFrame>> {
    let bad = || HalError::Protocol(format!("bad SLCAN frame {line:?}"));
    let (extended, id_len) = match line.as_bytes().first() {
        Some(b't') => (false, 3),
        Some(b'T') => (true, 8),
        Some(b'r' | b'R') => return Ok(None),
        _ => return Err(bad()),
    };
    let id_end = 1 + id_len;
    let id = line
        .get(1..id_end)
        .and_then(|s| u32::from_str_radix(s, 16).ok())
        .ok_or_else(bad)?;
    let dlc = line
        .get(id_end..id_end + 1)
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or_else(bad)?;
    let data_end = id_end + 1 + dlc * 2;
    let data = parse_hex(line.get(id_end + 1..data_end).ok_or_else(bad)?)?;
    // Anything after the data must be a 4-digit timestamp (Z1 mode).
    let tail = &line[data_end..];
    if !(tail.is_empty() || (tail.len() == 4 && tail.bytes().all(|b| b.is_ascii_hexdigit()))) {
        return Err(bad());
    }
    CanFrame::new(id, extended, &data).map(Some)
}

/// What one complete line from the device means.
#[derive(Debug, PartialEq)]
enum Event {
    Ok,
    Error,
    Frame(CanFrame),
}

/// SLCAN adapter over any serial link.
pub struct SlcanSerialAdapter<L: SerialLink> {
    link: L,
    buf: Vec<u8>,
    events: VecDeque<Event>,
    filters: Vec<CanFilter>,
    open: bool,
}

impl<L: SerialLink> SlcanSerialAdapter<L> {
    pub fn new(link: L) -> Self {
        Self {
            link,
            buf: Vec::new(),
            events: VecDeque::new(),
            filters: Vec::new(),
            open: false,
        }
    }

    /// The underlying link (tests check a replay finished).
    pub fn link(&self) -> &L {
        &self.link
    }

    /// Splits buffered bytes into events.
    fn ingest(&mut self, bytes: &[u8]) {
        for &b in bytes {
            match b {
                BEL => {
                    self.buf.clear();
                    self.events.push_back(Event::Error);
                }
                b'\r' => {
                    let line = String::from_utf8_lossy(&self.buf).into_owned();
                    self.buf.clear();
                    let event = match line.as_str() {
                        "" | "z" | "Z" => Event::Ok,
                        _ => match parse_frame_line(&line) {
                            Ok(Some(frame)) => Event::Frame(frame),
                            Ok(None) => continue,
                            Err(e) => {
                                tracing::warn!("ignoring SLCAN line: {e}");
                                continue;
                            }
                        },
                    };
                    self.events.push_back(event);
                }
                b'\n' => {}
                other => self.buf.push(other),
            }
        }
    }

    async fn fill(&mut self, timeout: Duration) -> Result<()> {
        let mut chunk = [0u8; 256];
        let n = self.link.read(&mut chunk, timeout).await?;
        self.ingest(&chunk[..n]);
        Ok(())
    }

    /// Sends a command and waits for OK or BEL, queueing frames that arrive meanwhile.
    async fn command(&mut self, cmd: &str) -> Result<()> {
        self.link.write_all(cmd.as_bytes()).await?;
        let deadline = Instant::now() + ACK_TIMEOUT;
        loop {
            if let Some(pos) = self
                .events
                .iter()
                .position(|e| !matches!(e, Event::Frame(_)))
            {
                let event = self.events.remove(pos).expect("position is valid");
                return match event {
                    Event::Ok => Ok(()),
                    _ => Err(HalError::Protocol(format!(
                        "adapter rejected {:?}",
                        cmd.trim_end()
                    ))),
                };
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(ACK_TIMEOUT));
            }
            self.fill(left).await?;
        }
    }
}

#[async_trait]
impl<L: SerialLink> VehicleBusAdapter for SlcanSerialAdapter<L> {
    async fn open(&mut self, bitrate: u32) -> Result<()> {
        let code = SLCAN_BITRATES
            .iter()
            .find(|(rate, _)| *rate == bitrate)
            .map(|(_, c)| *c)
            .ok_or_else(|| {
                HalError::Unsupported(format!("SLCAN has no code for {bitrate} bit/s"))
            })?;
        // Close first in case the channel was left open; BEL here just means "already closed".
        let _ = self.command("C\r").await;
        self.command(&format!("S{code}\r")).await?;
        self.command("O\r").await?;
        self.events.retain(|e| !matches!(e, Event::Frame(_)));
        self.open = true;
        Ok(())
    }

    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()> {
        self.filters = filters.to_vec();
        Ok(())
    }

    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
        if !self.open {
            return Err(HalError::NotOpen);
        }
        self.command(&encode_frame(frame)).await
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        if !self.open {
            return Err(HalError::NotOpen);
        }
        let deadline = Instant::now() + timeout;
        loop {
            while let Some(pos) = self
                .events
                .iter()
                .position(|e| matches!(e, Event::Frame(_)))
            {
                if let Some(Event::Frame(frame)) = self.events.remove(pos) {
                    if passes(&self.filters, &frame) {
                        return Ok(frame);
                    }
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(timeout));
            }
            match self.fill(left).await {
                Err(HalError::Timeout(_)) => return Err(HalError::Timeout(timeout)),
                other => other?,
            }
        }
    }

    async fn close(&mut self) -> Result<()> {
        self.open = false;
        self.command("C\r").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hal::serial::ReplaySerial;

    const T: Duration = Duration::from_millis(100);

    #[test]
    fn encode_and_parse() {
        let std = CanFrame::std(0x7DF, &[0x02, 0x01, 0x0D]);
        assert_eq!(encode_frame(&std), "t7DF302010D\r");
        let ext = CanFrame::ext(0x18DA_F110, &[0x03, 0x22, 0xF1, 0x90]);
        assert_eq!(encode_frame(&ext), "T18DAF11040322F190\r");
        assert_eq!(parse_frame_line("t7DF302010D").unwrap(), Some(std));
        assert_eq!(
            parse_frame_line("T18DAF11040322F1901A2B").unwrap(),
            Some(ext),
            "with timestamp"
        );
        assert_eq!(
            parse_frame_line("t1230").unwrap(),
            Some(CanFrame::std(0x123, &[]))
        );
        assert_eq!(parse_frame_line("r1230").unwrap(), None);
        for bad in ["t7DF9", "t7DF30201", "x123", "t80000", "t7DF102XYZ"] {
            assert!(parse_frame_line(bad).is_err(), "{bad}");
        }
    }

    /// Task 1.1 gate: a recorded Flipper Zero SLCAN session parses end to end.
    #[tokio::test]
    async fn recorded_flipper_session() {
        let link = ReplaySerial::from_script(include_str!("../../fixtures/hal/slcan_flipper.txt"))
            .unwrap();
        let mut a = SlcanSerialAdapter::new(link);
        a.open(500_000).await.unwrap();
        a.set_filter(&[
            CanFilter {
                id: 0x7E8,
                mask: 0x7F8,
                extended: false,
            },
            CanFilter::exact(0x18DA_F110, true),
        ])
        .await
        .unwrap();
        a.send_frame(&CanFrame::std(
            0x7DF,
            &[0x02, 0x01, 0x0D, 0x00, 0x00, 0x00, 0x00, 0x00],
        ))
        .await
        .unwrap();
        let reply = a.recv_frame(T).await.unwrap();
        assert_eq!(
            (reply.id(), &reply.data()[..4]),
            (0x7E8, &[0x03u8, 0x41, 0x0D, 0x00][..])
        );
        // The broadcast 0x0C9 frame in the stream is filtered out; the 29-bit reply is kept.
        let ext = a.recv_frame(T).await.unwrap();
        assert_eq!((ext.id(), ext.is_extended()), (0x18DA_F110, true));
        // The device rejects an oversize frame command with BEL.
        assert!(a
            .send_frame(&CanFrame::std(0x7E0, &[0x02, 0x3E, 0x00]))
            .await
            .is_err());
        a.close().await.unwrap();
        assert!(
            a.link().is_finished(),
            "unused recording: {:?}",
            a.link().remaining()
        );
    }

    #[tokio::test]
    async fn unsupported_bitrate() {
        let mut a = SlcanSerialAdapter::new(ReplaySerial::new(Vec::new()));
        assert!(matches!(
            a.open(33_333).await,
            Err(HalError::Unsupported(_))
        ));
        assert!(matches!(
            a.send_frame(&CanFrame::std(1, &[])).await,
            Err(HalError::NotOpen)
        ));
    }
}
