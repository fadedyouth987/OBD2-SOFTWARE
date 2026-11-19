//! Hardware abstraction layer (Task 1.1).
//!
//! Two adapter shapes, because CAN and K-line behave differently:
//! - [`VehicleBusAdapter`]: frame-oriented CAN (SocketCAN, SLCAN, STN/ELM in raw
//!   CAN mode, J2534, and the in-memory [`virtual_bus::VirtualBusAdapter`]).
//! - [`KLineAdapter`]: byte-oriented, half-duplex ISO 9141 / ISO 14230 K-line
//!   (K+DCAN cables via FTDI, and [`virtual_kline::VirtualKLineAdapter`]).
//!
//! `protocols::DiagTransport` (request bytes in, response bytes out, Task 1.2)
//! sits above both. Every adapter starts in `SILENT` mode: the HAL moves bytes
//! only; gating happens in `SafetyInterlock`, which every transport calls (A-ENG-4).
//!
//! Rule 2: production adapters never fake a protocol. Serial-based adapters run
//! their real protocol code over a [`serial::SerialLink`], which is either a real
//! port or, in tests, a replay of a recorded byte stream.

use std::{fmt, time::Duration};

use async_trait::async_trait;

pub mod discovery;
pub mod j2534_win;
pub mod kline_ftdi;
pub mod serial;
pub mod slcan_serial;
pub mod stn_elm;
pub mod virtual_bus;
pub mod virtual_kline;

#[cfg(target_os = "linux")]
pub mod socketcan_linux;

/// Largest classic CAN payload.
pub const CAN_MAX_DLC: usize = 8;
/// Largest 11-bit identifier.
pub const CAN_SFF_MAX: u32 = 0x7FF;
/// Largest 29-bit identifier.
pub const CAN_EFF_MAX: u32 = 0x1FFF_FFFF;

/// Errors from any adapter.
#[derive(Debug, thiserror::Error)]
pub enum HalError {
    #[error("adapter is not open")]
    NotOpen,
    #[error("timed out after {0:?}")]
    Timeout(Duration),
    #[error("invalid CAN frame: {0}")]
    InvalidFrame(String),
    #[error("adapter protocol error: {0}")]
    Protocol(String),
    #[error("not supported by this adapter: {0}")]
    Unsupported(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, HalError>;

/// One classic CAN 2.0 frame.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct CanFrame {
    id: u32,
    extended: bool,
    len: u8,
    data: [u8; CAN_MAX_DLC],
}

impl CanFrame {
    /// Builds a frame, checking the identifier range and the payload length.
    pub fn new(id: u32, extended: bool, data: &[u8]) -> Result<Self> {
        let max = if extended { CAN_EFF_MAX } else { CAN_SFF_MAX };
        if id > max {
            return Err(HalError::InvalidFrame(format!(
                "id {id:#X} exceeds the {}-bit range",
                if extended { 29 } else { 11 }
            )));
        }
        if data.len() > CAN_MAX_DLC {
            return Err(HalError::InvalidFrame(format!(
                "{} data bytes (max 8)",
                data.len()
            )));
        }
        let mut buf = [0u8; CAN_MAX_DLC];
        buf[..data.len()].copy_from_slice(data);
        Ok(Self {
            id,
            extended,
            len: data.len() as u8,
            data: buf,
        })
    }

    /// 11-bit frame. Panics on an invalid id or length: for literals in code and tests.
    pub fn std(id: u32, data: &[u8]) -> Self {
        Self::new(id, false, data).expect("valid 11-bit frame")
    }

    /// 29-bit frame. Panics on an invalid id or length: for literals in code and tests.
    pub fn ext(id: u32, data: &[u8]) -> Self {
        Self::new(id, true, data).expect("valid 29-bit frame")
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn is_extended(&self) -> bool {
        self.extended
    }

    pub fn data(&self) -> &[u8] {
        &self.data[..self.len as usize]
    }

    pub fn dlc(&self) -> u8 {
        self.len
    }
}

impl fmt::Debug for CanFrame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let width = if self.extended { 8 } else { 3 };
        write!(f, "{:0width$X} [{}]", self.id, self.len)?;
        for byte in self.data() {
            write!(f, " {byte:02X}")?;
        }
        Ok(())
    }
}

/// Acceptance filter: a frame passes when `frame.id & mask == id & mask` and the
/// identifier width matches. No filters means accept everything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CanFilter {
    pub id: u32,
    pub mask: u32,
    pub extended: bool,
}

impl CanFilter {
    /// Matches exactly one identifier.
    pub fn exact(id: u32, extended: bool) -> Self {
        let mask = if extended { CAN_EFF_MAX } else { CAN_SFF_MAX };
        Self { id, mask, extended }
    }

    pub fn matches(&self, frame: &CanFrame) -> bool {
        frame.extended == self.extended && (frame.id & self.mask) == (self.id & self.mask)
    }
}

/// True when `frame` passes `filters` (an empty list accepts everything).
pub fn passes(filters: &[CanFilter], frame: &CanFrame) -> bool {
    filters.is_empty() || filters.iter().any(|f| f.matches(frame))
}

/// Frame-oriented CAN adapter.
#[async_trait]
pub trait VehicleBusAdapter: Send {
    /// Opens the adapter at `bitrate` bits per second.
    async fn open(&mut self, bitrate: u32) -> Result<()>;
    /// Replaces the acceptance filters. An empty slice accepts everything.
    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()>;
    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()>;
    /// Waits up to `timeout` for the next frame that passes the filters.
    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame>;
    async fn close(&mut self) -> Result<()>;
}

/// The key bytes an ECU sends after a successful K-line wake-up (KB1, KB2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyBytes {
    pub kb1: u8,
    pub kb2: u8,
}

/// Byte-oriented, half-duplex K-line adapter.
///
/// K-line cables echo every byte the tester sends; adapters consume and check
/// that echo, so [`read_bytes`](Self::read_bytes) returns only bytes from the ECU.
#[async_trait]
pub trait KLineAdapter: Send {
    /// Opens the line at `baud` (10,400 for ISO 14230 / ISO 9141).
    async fn open(&mut self, baud: u32) -> Result<()>;
    /// ISO 14230-2 fast init: 25 ms low, 25 ms high. The tester then sends
    /// StartCommunication (0x81) with `write_bytes`.
    async fn wake_fast_init(&mut self) -> Result<()>;
    /// ISO 9141 / ISO 14230 5-baud init to `addr`; completes the key-byte
    /// handshake and returns the key bytes.
    async fn wake_5baud(&mut self, addr: u8) -> Result<KeyBytes>;
    async fn write_bytes(&mut self, bytes: &[u8]) -> Result<()>;
    /// Returns up to `max` ECU bytes, waiting up to `timeout` for the first one
    /// and then returning whatever has arrived. Errors with `Timeout` if none.
    async fn read_bytes(&mut self, max: usize, timeout: Duration) -> Result<Vec<u8>>;
    async fn close(&mut self) -> Result<()>;
}

/// Standard CAN bitrates and their SLCAN `Sn` codes.
pub const SLCAN_BITRATES: [(u32, char); 9] = [
    (10_000, '0'),
    (20_000, '1'),
    (50_000, '2'),
    (100_000, '3'),
    (125_000, '4'),
    (250_000, '5'),
    (500_000, '6'),
    (800_000, '7'),
    (1_000_000, '8'),
];

/// Parses hex with optional whitespace, e.g. "02 10 03" or "021003".
pub fn parse_hex(text: &str) -> Result<Vec<u8>> {
    let digits: Vec<u8> = text.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if !digits.len().is_multiple_of(2) {
        return Err(HalError::Protocol(format!("odd-length hex {text:?}")));
    }
    digits
        .chunks(2)
        .map(|pair| {
            let s = std::str::from_utf8(pair)
                .map_err(|_| HalError::Protocol("non-ASCII hex".into()))?;
            u8::from_str_radix(s, 16).map_err(|_| HalError::Protocol(format!("bad hex {text:?}")))
        })
        .collect()
}

/// Formats bytes as uppercase hex without separators.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_validation() {
        assert!(CanFrame::new(0x7FF, false, &[]).is_ok());
        assert!(CanFrame::new(0x800, false, &[]).is_err());
        assert!(CanFrame::new(0x1FFF_FFFF, true, &[0; 8]).is_ok());
        assert!(CanFrame::new(0x2000_0000, true, &[]).is_err());
        assert!(CanFrame::new(0x100, false, &[0; 9]).is_err());
        let f = CanFrame::std(0x7E8, &[0x02, 0x41]);
        assert_eq!((f.id(), f.dlc(), f.data()), (0x7E8, 2, &[0x02u8, 0x41][..]));
        assert_eq!(format!("{f:?}"), "7E8 [2] 02 41");
    }

    #[test]
    fn filters() {
        let f = CanFilter::exact(0x7E8, false);
        assert!(f.matches(&CanFrame::std(0x7E8, &[])));
        assert!(!f.matches(&CanFrame::std(0x7E9, &[])));
        assert!(!f.matches(&CanFrame::ext(0x7E8, &[])));
        let range = CanFilter {
            id: 0x7E8,
            mask: 0x7F8,
            extended: false,
        };
        assert!(range.matches(&CanFrame::std(0x7EF, &[])));
        assert!(passes(&[], &CanFrame::std(1, &[])));
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(parse_hex("02 10 03").unwrap(), vec![0x02, 0x10, 0x03]);
        assert_eq!(to_hex(&[0x0A, 0xFF]), "0AFF");
        assert!(parse_hex("ABC").is_err());
        assert!(parse_hex("GG").is_err());
    }
}
