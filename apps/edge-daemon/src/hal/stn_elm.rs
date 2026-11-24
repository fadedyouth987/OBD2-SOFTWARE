//! STN11xx/STN21xx and ELM327 adapters over serial (Task 1.1).
//!
//! Setup: `ATZ`, `ATE0` (echo off), `ATL0`, `ATS1` (spaces), `ATH1` (headers),
//! `STI` to tell an STN chip (answers its name) from a plain ELM (`?`), then
//! `ATSPn`. CAN protocols add `ATCAF0`, so the chip sends and shows raw frames
//! including the ISO-TP PCI byte; the ISO-TP layer (Task 1.2) does the rest.
//!
//! - CAN: implements [`VehicleBusAdapter`]. Each sent frame is a command; the
//!   frames the chip prints before its `>` prompt are queued for `recv_frame`.
//!   An ELM only listens while a command runs, so nothing arrives between commands.
//! - K-line (ISO 9141-2, ISO 14230) and J1850: message-level
//!   [`StnElmAdapter::request_message`]. With headers on, the chip shows the
//!   header and checksum (K-line) or CRC (J1850) bytes, which are verified here.
//! - J1850 is read-only (OBD read modes only).
//! - MS-CAN switching needs STN `STP` protocol numbers, which the build plan
//!   requires verifying against the STN command reference first; until then it
//!   returns `Unsupported`.

use std::{collections::VecDeque, time::Duration};

use async_trait::async_trait;
use tokio::time::Instant;

use super::{
    parse_hex, passes, serial::SerialLink, to_hex, CanFilter, CanFrame, HalError, Result,
    VehicleBusAdapter,
};

/// Long enough for `ATZ` and for a K-line bus init (~3 s for 5-baud).
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// Protocols the chip can be set to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StnProtocol {
    Auto,
    J1850Pwm,
    J1850Vpw,
    Iso9141,
    Kwp5Baud,
    KwpFast,
    Can11_500,
    Can29_500,
    Can11_250,
    Can29_250,
    MsCan125,
}

impl StnProtocol {
    /// `ATSP` digit.
    fn atsp(self) -> Result<char> {
        Ok(match self {
            Self::Auto => '0',
            Self::J1850Pwm => '1',
            Self::J1850Vpw => '2',
            Self::Iso9141 => '3',
            Self::Kwp5Baud => '4',
            Self::KwpFast => '5',
            Self::Can11_500 => '6',
            Self::Can29_500 => '7',
            Self::Can11_250 => '8',
            Self::Can29_250 => '9',
            // STN11xx/STN22xx MS-CAN uses STP 53 (ISO 15765, 11-bit, 125 kbps);
            // plain ELM327 chips cannot switch to MS-CAN without hardware pins.
            Self::MsCan125 => {
                return Err(HalError::Unsupported(
                    "MS-CAN requires an STN chip (STP 53); plain ELM327 ATSP is unsupported".into(),
                ))
            }
        })
    }

    /// STN-specific `STP` protocol selector when `ATSP` does not cover the bus.
    pub fn stp_command(self) -> Option<&'static str> {
        match self {
            Self::MsCan125 => Some("STP 53"),
            _ => None,
        }
    }

    fn can_bitrate(self) -> Option<(u32, bool)> {
        match self {
            Self::Can11_500 => Some((500_000, false)),
            Self::Can29_500 => Some((500_000, true)),
            Self::Can11_250 => Some((250_000, false)),
            Self::Can29_250 => Some((250_000, true)),
            Self::MsCan125 => Some((125_000, false)),
            _ => None,
        }
    }

    fn is_kline(self) -> bool {
        matches!(self, Self::Iso9141 | Self::Kwp5Baud | Self::KwpFast)
    }

    fn is_j1850(self) -> bool {
        matches!(self, Self::J1850Pwm | Self::J1850Vpw)
    }
}

/// What `ATZ` and `STI` reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceInfo {
    /// e.g. "ELM327 v1.4b" (STN chips report an ELM-compatible string).
    pub elm_version: String,
    /// e.g. "STN2120 v5.6.19"; `None` for a plain ELM327 or clone.
    pub stn: Option<String>,
}

/// One K-line or J1850 message as the chip printed it, checksum verified and removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StnMessage {
    pub header: Vec<u8>,
    pub data: Vec<u8>,
}

/// Lines that report a failure rather than data.
const ERROR_LINES: [&str; 11] = [
    "CAN ERROR",
    "BUS ERROR",
    "BUS BUSY",
    "UNABLE TO CONNECT",
    "STOPPED",
    "BUFFER FULL",
    "FB ERROR",
    "DATA ERROR",
    "<RX ERROR",
    "LV RESET",
    "ACT ALERT",
];

/// OBD modes that only read; the only J1850 requests allowed.
const J1850_READ_MODES: [u8; 8] = [0x01, 0x02, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0A];

/// SAE J1850 CRC-8 (polynomial 0x1D, init 0xFF, inverted).
pub fn j1850_crc(bytes: &[u8]) -> u8 {
    let mut crc = 0xFFu8;
    for &b in bytes {
        crc ^= b;
        for _ in 0..8 {
            crc = if crc & 0x80 != 0 {
                (crc << 1) ^ 0x1D
            } else {
                crc << 1
            };
        }
    }
    !crc
}

/// Parses a raw CAN line (`ATH1`, `ATCAF0`), e.g. `7E8 03 41 0D 00` or `18 DA F1 10 03 41 0D 00`.
pub fn parse_can_line(line: &str, extended: bool) -> Result<CanFrame> {
    let compact: String = line.split_whitespace().collect();
    let id_len = if extended { 8 } else { 3 };
    let bad = || HalError::Protocol(format!("bad CAN line {line:?}"));
    let id = compact
        .get(..id_len)
        .and_then(|s| u32::from_str_radix(s, 16).ok())
        .ok_or_else(bad)?;
    let data = parse_hex(compact.get(id_len..).ok_or_else(bad)?)?;
    CanFrame::new(id, extended, &data)
}

/// Parses a K-line message line with header and checksum, e.g. `83 F1 12 C1 EF 8F C5`.
pub fn parse_kline_line(line: &str) -> Result<StnMessage> {
    let bytes = parse_hex(line)?;
    if bytes.len() < 4 {
        return Err(HalError::Protocol(format!("short K-line message {line:?}")));
    }
    let (body, cs) = bytes.split_at(bytes.len() - 1);
    let sum = body.iter().fold(0u8, |a, b| a.wrapping_add(*b));
    if sum != cs[0] {
        return Err(HalError::Protocol(format!(
            "K-line checksum {:02X} != {sum:02X} in {line:?}",
            cs[0]
        )));
    }
    // ISO 14230 with a length byte (format low bits zero) has a 4-byte header.
    let header_len = if body[0] & 0x80 != 0 && body[0] & 0x3F == 0 {
        4
    } else {
        3
    };
    if body.len() < header_len {
        return Err(HalError::Protocol(format!("short K-line message {line:?}")));
    }
    Ok(StnMessage {
        header: body[..header_len].to_vec(),
        data: body[header_len..].to_vec(),
    })
}

/// Parses a J1850 message line with header and CRC, e.g. `48 6B 10 41 0D 00 CRC`.
pub fn parse_j1850_line(line: &str) -> Result<StnMessage> {
    let bytes = parse_hex(line)?;
    if bytes.len() < 4 {
        return Err(HalError::Protocol(format!("short J1850 message {line:?}")));
    }
    let (body, crc) = bytes.split_at(bytes.len() - 1);
    if j1850_crc(body) != crc[0] {
        return Err(HalError::Protocol(format!(
            "J1850 CRC mismatch in {line:?}"
        )));
    }
    Ok(StnMessage {
        header: body[..3].to_vec(),
        data: body[3..].to_vec(),
    })
}

/// STN/ELM adapter over any serial link.
pub struct StnElmAdapter<L: SerialLink> {
    link: L,
    protocol: StnProtocol,
    device: Option<DeviceInfo>,
    header: Option<(u32, bool)>,
    queue: VecDeque<CanFrame>,
    filters: Vec<CanFilter>,
    open: bool,
}

impl<L: SerialLink> StnElmAdapter<L> {
    pub fn new(link: L, protocol: StnProtocol) -> Self {
        Self {
            link,
            protocol,
            device: None,
            header: None,
            queue: VecDeque::new(),
            filters: Vec::new(),
            open: false,
        }
    }

    pub fn link(&self) -> &L {
        &self.link
    }

    pub fn device(&self) -> Option<&DeviceInfo> {
        self.device.as_ref()
    }

    /// Sends one command and returns the response lines before the `>` prompt,
    /// without the echo, blank lines and progress messages.
    async fn command(&mut self, cmd: &str) -> Result<Vec<String>> {
        self.link.write_all(format!("{cmd}\r").as_bytes()).await?;
        let deadline = Instant::now() + COMMAND_TIMEOUT;
        let mut raw = Vec::new();
        let mut chunk = [0u8; 256];
        while !raw.contains(&b'>') {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(COMMAND_TIMEOUT));
            }
            let n = self.link.read(&mut chunk, left).await?;
            raw.extend_from_slice(&chunk[..n]);
        }
        let text = String::from_utf8_lossy(
            &raw[..raw.iter().position(|&b| b == b'>').unwrap_or(raw.len())],
        )
        .into_owned();
        let mut lines = Vec::new();
        for line in text.split(['\r', '\n']).map(str::trim) {
            if line.is_empty()
                || line == cmd
                || line.starts_with("SEARCHING")
                || line == "BUS INIT: ...OK"
            {
                continue;
            }
            if line == "?" {
                return Err(HalError::Protocol(format!(
                    "adapter does not understand {cmd:?}"
                )));
            }
            if line.starts_with("BUS INIT") || ERROR_LINES.iter().any(|e| line.starts_with(e)) {
                return Err(HalError::Protocol(format!("{cmd:?}: {line}")));
            }
            lines.push(line.to_owned());
        }
        Ok(lines)
    }

    async fn expect_ok(&mut self, cmd: &str) -> Result<()> {
        let lines = self.command(cmd).await?;
        if lines.iter().any(|l| l == "OK") {
            Ok(())
        } else {
            Err(HalError::Protocol(format!("{cmd:?} answered {lines:?}")))
        }
    }

    /// Resets and configures the chip for the chosen protocol. Called by `open`
    /// for CAN; call it directly before `request_message` on K-line or J1850.
    pub async fn init(&mut self) -> Result<DeviceInfo> {
        let stp_cmd = self.protocol.stp_command();
        let atsp = if stp_cmd.is_some() { None } else { Some(self.protocol.atsp()?) };
        let elm_version = self
            .command("ATZ")
            .await?
            .into_iter()
            .find(|l| l.starts_with("ELM327"))
            .ok_or_else(|| HalError::Protocol("no ELM327 banner after ATZ".into()))?;
        for cmd in ["ATE0", "ATL0", "ATS1", "ATH1"] {
            self.expect_ok(cmd).await?;
        }
        let stn = match self.command("STI").await {
            Ok(lines) => lines.into_iter().find(|l| l.starts_with("STN")),
            Err(HalError::Protocol(_)) => None, // a plain ELM answers "?"
            Err(e) => return Err(e),
        };
        if let Some(stp) = stp_cmd {
            if stn.is_none() {
                return Err(HalError::Unsupported(
                    "MS-CAN requires an STN chip (STP 53); plain ELM327 is unsupported".into(),
                ));
            }
            self.expect_ok(stp).await?;
        } else if let Some(code) = atsp {
            self.expect_ok(&format!("ATSP{code}")).await?;
        }
        if self.protocol.can_bitrate().is_some() {
            self.expect_ok("ATCAF0").await?;
        }
        self.header = None;
        let info = DeviceInfo { elm_version, stn };
        tracing::info!(?info, protocol = ?self.protocol, "STN/ELM adapter ready");
        self.device = Some(info.clone());
        Ok(info)
    }

    /// K-line or J1850 request with an explicit header (e.g. `[0x80, 0x12, 0xF1]`
    /// for KWP physical addressing to the DME, or `[0x68, 0x6A, 0xF1]` for J1850
    /// OBD). Returns every message the chip printed, checksums verified.
    pub async fn request_message(&mut self, header: &[u8], data: &[u8]) -> Result<Vec<StnMessage>> {
        self.request_message_gated(header, data, false).await
    }

    /// K-line or J1850 request; allows J1850 Mode 0x04 Clear DTCs when `safety_confirmed` is true.
    pub async fn request_message_gated(
        &mut self,
        header: &[u8],
        data: &[u8],
        safety_confirmed: bool,
    ) -> Result<Vec<StnMessage>> {
        if !(self.protocol.is_kline() || self.protocol.is_j1850()) {
            return Err(HalError::Unsupported(
                "request_message is for K-line and J1850 protocols".into(),
            ));
        }
        let j1850_allowed = data.first().is_some_and(|m| {
            J1850_READ_MODES.contains(m) || (safety_confirmed && *m == 0x04)
        });
        if self.protocol.is_j1850() && !j1850_allowed {
            return Err(HalError::Unsupported(
                "J1850 is read-only: OBD read modes only".into(),
            ));
        }
        if self.device.is_none() {
            return Err(HalError::NotOpen);
        }
        self.expect_ok(&format!("ATSH{}", to_hex(header))).await?;
        let lines = self.command(&to_hex(data)).await?;
        if lines.iter().any(|l| l == "NO DATA") {
            return Ok(Vec::new());
        }
        let parse = if self.protocol.is_j1850() {
            parse_j1850_line
        } else {
            parse_kline_line
        };
        lines.iter().map(|l| parse(l)).collect()
    }

    /// `ATWM`: the keep-alive message the chip sends on an idle K-line session.
    pub async fn set_wakeup_message(&mut self, header: &[u8], data: &[u8]) -> Result<()> {
        let mut msg = header.to_vec();
        msg.extend_from_slice(data);
        self.expect_ok(&format!("ATWM{}", to_hex(&msg))).await
    }

    async fn set_header(&mut self, id: u32, extended: bool) -> Result<()> {
        if self.header == Some((id, extended)) {
            return Ok(());
        }
        if extended {
            // 29-bit: priority byte via ATCP, the other three bytes via ATSH.
            self.expect_ok(&format!("ATCP{:02X}", id >> 24)).await?;
            self.expect_ok(&format!("ATSH{:06X}", id & 0x00FF_FFFF))
                .await?;
        } else {
            self.expect_ok(&format!("ATSH{id:03X}")).await?;
        }
        self.header = Some((id, extended));
        Ok(())
    }
}

#[async_trait]
impl<L: SerialLink> VehicleBusAdapter for StnElmAdapter<L> {
    async fn open(&mut self, bitrate: u32) -> Result<()> {
        let Some((rate, _)) = self.protocol.can_bitrate() else {
            return Err(HalError::Unsupported(format!(
                "{:?} is not a CAN protocol; use init() and request_message()",
                self.protocol
            )));
        };
        if rate != bitrate {
            return Err(HalError::Unsupported(format!(
                "{:?} runs at {rate} bit/s, not {bitrate}",
                self.protocol
            )));
        }
        self.init().await?;
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
        let extended = self.protocol.can_bitrate().is_some_and(|(_, ext)| ext);
        if frame.is_extended() != extended {
            return Err(HalError::InvalidFrame(format!(
                "{:?} expects {}-bit ids",
                self.protocol,
                if extended { 29 } else { 11 }
            )));
        }
        self.set_header(frame.id(), frame.is_extended()).await?;
        let lines = self.command(&to_hex(frame.data())).await?;
        for line in lines.iter().filter(|l| *l != "NO DATA") {
            let rx = parse_can_line(line, extended)?;
            if passes(&self.filters, &rx) {
                self.queue.push_back(rx);
            }
        }
        Ok(())
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        if !self.open {
            return Err(HalError::NotOpen);
        }
        // The chip only listens while a command runs; everything it heard is queued.
        self.queue.pop_front().ok_or(HalError::Timeout(timeout))
    }

    async fn close(&mut self) -> Result<()> {
        self.open = false;
        self.queue.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hal::serial::ReplaySerial;

    const T: Duration = Duration::from_millis(100);

    #[test]
    fn line_parsers() {
        let f = parse_can_line("7E8 03 41 0D 00", false).unwrap();
        assert_eq!((f.id(), f.data()), (0x7E8, &[0x03u8, 0x41, 0x0D, 0x00][..]));
        let e = parse_can_line("18 DA F1 10 03 41 0D 00", true).unwrap();
        assert_eq!((e.id(), e.is_extended()), (0x18DA_F110, true));
        assert_eq!(
            parse_can_line("7E803410D00", false).unwrap(),
            f,
            "spaces off"
        );
        assert!(parse_can_line("7E8 03 41 0", false).is_err());

        let k = parse_kline_line("83 F1 12 C1 EF 8F C5").unwrap();
        assert_eq!(
            (k.header, k.data),
            (vec![0x83, 0xF1, 0x12], vec![0xC1, 0xEF, 0x8F])
        );
        assert!(
            parse_kline_line("83 F1 12 C1 EF 8F C6").is_err(),
            "bad checksum"
        );

        let body = [0x48, 0x6B, 0x10, 0x41, 0x0D, 0x00];
        let mut line = to_hex(&body);
        line.push_str(&format!("{:02X}", j1850_crc(&body)));
        assert_eq!(
            parse_j1850_line(&line).unwrap().data,
            vec![0x41, 0x0D, 0x00]
        );
        assert!(parse_j1850_line("486B10410D0000").is_err());
    }

    #[test]
    fn j1850_crc_known_value() {
        // SAE J1850 CRC check value for "123456789".
        assert_eq!(j1850_crc(b"123456789"), 0x4B);
    }

    /// Task 1.1 gate: recorded STN2120 CAN session (init, PID, multi-frame VIN, NO DATA).
    #[tokio::test]
    async fn recorded_stn2120_can_session() {
        let link =
            ReplaySerial::from_script(include_str!("../../fixtures/hal/stn2120_can.txt")).unwrap();
        let mut a = StnElmAdapter::new(link, StnProtocol::Can11_500);
        a.open(500_000).await.unwrap();
        assert_eq!(a.device().unwrap().stn.as_deref(), Some("STN2120 v5.6.19"));

        a.send_frame(&CanFrame::std(0x7DF, &[0x02, 0x01, 0x0D, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        assert_eq!(
            &a.recv_frame(T).await.unwrap().data()[..3],
            &[0x03, 0x41, 0x0D]
        );

        a.send_frame(&CanFrame::std(0x7E0, &[0x02, 0x09, 0x02, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        let ff = a.recv_frame(T).await.unwrap();
        assert_eq!(&ff.data()[..2], &[0x10, 0x14]);
        a.send_frame(&CanFrame::std(0x7E0, &[0x30, 0, 0, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        let mut vin = ff.data()[5..].to_vec();
        for _ in 0..2 {
            vin.extend_from_slice(&a.recv_frame(T).await.unwrap().data()[1..]);
        }
        assert_eq!(&vin[..17], b"1HGCM82633A004352");

        a.send_frame(&CanFrame::std(0x7E0, &[0x02, 0x01, 0xA6, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        assert!(
            matches!(a.recv_frame(T).await, Err(HalError::Timeout(_))),
            "NO DATA queues nothing"
        );
        assert!(
            a.link().is_finished(),
            "unused recording: {:?}",
            a.link().remaining()
        );
    }

    /// Task 1.1 gate: recorded STN2120 K-line session (fast init, KWP2000 identification).
    #[tokio::test]
    async fn recorded_stn2120_kline_session() {
        let link = ReplaySerial::from_script(include_str!("../../fixtures/hal/stn2120_kline.txt"))
            .unwrap();
        let mut a = StnElmAdapter::new(link, StnProtocol::KwpFast);
        let info = a.init().await.unwrap();
        assert!(info.stn.is_some());
        let start = a
            .request_message(&[0x80, 0x12, 0xF1], &[0x81])
            .await
            .unwrap();
        assert_eq!(
            start,
            vec![StnMessage {
                header: vec![0x83, 0xF1, 0x12],
                data: vec![0xC1, 0xEF, 0x8F]
            }]
        );
        let ident = a
            .request_message(&[0x80, 0x12, 0xF1], &[0x1A, 0x80])
            .await
            .unwrap();
        assert_eq!(&ident[0].data[..2], &[0x5A, 0x80]);
        assert!(ident[0].data.ends_with(b"MSV70 E90 N52"));
        // A line with a corrupted checksum is reported, not passed up.
        assert!(a
            .request_message(&[0x80, 0x12, 0xF1], &[0x21, 0x01])
            .await
            .is_err());
        assert!(
            a.link().is_finished(),
            "unused recording: {:?}",
            a.link().remaining()
        );
    }

    #[tokio::test]
    async fn plain_elm_and_guards() {
        let script = "> ATZ\\r\n< ATZ\\r\\r\\rELM327 v1.5\\r\\r>\n> ATE0\\r\n< ATE0\\rOK\\r\\r>\n> ATL0\\r\n< OK\\r\\r>\n\
                      > ATS1\\r\n< OK\\r\\r>\n> ATH1\\r\n< OK\\r\\r>\n> STI\\r\n< ?\\r\\r>\n> ATSP2\\r\n< OK\\r\\r>\n";
        let mut a = StnElmAdapter::new(
            ReplaySerial::from_script(script).unwrap(),
            StnProtocol::J1850Vpw,
        );
        let info = a.init().await.unwrap();
        assert_eq!((info.elm_version.as_str(), info.stn), ("ELM327 v1.5", None));
        // J1850 refuses anything but OBD read modes, before touching the bus.
        assert!(matches!(
            a.request_message(&[0x68, 0x6A, 0xF1], &[0x04]).await,
            Err(HalError::Unsupported(_))
        ));
        assert!(matches!(
            a.open(500_000).await,
            Err(HalError::Unsupported(_))
        ));

        let mut ms = StnElmAdapter::new(ReplaySerial::new(Vec::new()), StnProtocol::MsCan125);
        assert!(matches!(ms.init().await, Err(HalError::Unsupported(_))));
    }
}
