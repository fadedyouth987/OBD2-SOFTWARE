//! ISO 14230-2 (KWP2000 on K-line) message framing, for the virtual K-line.
//!
//! Format byte: bits 7–6 address mode (10 physical, 11 functional, 00 none),
//! bits 5–0 data length (0 means a separate length byte follows the addresses).
//! Then target and source addresses, data, and a checksum (sum mod 256).

/// One K-line message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KFrame {
    pub functional: bool,
    pub target: u8,
    pub source: u8,
    pub data: Vec<u8>,
}

/// Outcome of parsing the start of a byte buffer.
#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    /// A full message and how many bytes it used.
    Frame(KFrame, usize),
    /// More bytes needed.
    Incomplete,
    /// Not a valid message start (bad format byte or checksum); skip one byte.
    Invalid,
}

pub fn checksum(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0u8, |acc, b| acc.wrapping_add(*b))
}

/// Builds a message with physical (or functional) addressing.
pub fn build(frame: &KFrame) -> Vec<u8> {
    let mode = if frame.functional { 0xC0 } else { 0x80 };
    let len = frame.data.len();
    let mut out = if len <= 0x3F {
        vec![mode | len as u8, frame.target, frame.source]
    } else {
        vec![mode, frame.target, frame.source, len as u8]
    };
    out.extend_from_slice(&frame.data);
    out.push(checksum(&out));
    out
}

pub fn parse(buf: &[u8]) -> Parsed {
    let Some(&fmt) = buf.first() else {
        return Parsed::Incomplete;
    };
    let mode = fmt & 0xC0;
    if mode != 0x80 && mode != 0xC0 {
        return Parsed::Invalid; // only addressed formats are used by these ECUs
    }
    if buf.len() < 3 {
        return Parsed::Incomplete;
    }
    let (len, header) = match fmt & 0x3F {
        0 => match buf.get(3) {
            Some(&l) => (usize::from(l), 4),
            None => return Parsed::Incomplete,
        },
        l => (usize::from(l), 3),
    };
    let total = header + len + 1;
    if buf.len() < total {
        return Parsed::Incomplete;
    }
    if checksum(&buf[..total - 1]) != buf[total - 1] {
        return Parsed::Invalid;
    }
    let frame = KFrame {
        functional: mode == 0xC0,
        target: buf[1],
        source: buf[2],
        data: buf[header..header + len].to_vec(),
    };
    Parsed::Frame(frame, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_communication_frames() {
        let req = KFrame {
            functional: false,
            target: 0x12,
            source: 0xF1,
            data: vec![0x81],
        };
        assert_eq!(build(&req), vec![0x81, 0x12, 0xF1, 0x81, 0x05]);
        let resp = [0x83, 0xF1, 0x12, 0xC1, 0xEF, 0x8F, 0xC5];
        let Parsed::Frame(frame, used) = parse(&resp) else {
            panic!("parse failed")
        };
        assert_eq!((frame.data, used), (vec![0xC1, 0xEF, 0x8F], 7));
    }

    #[test]
    fn long_frames_use_a_length_byte() {
        let frame = KFrame {
            functional: false,
            target: 0xF1,
            source: 0x12,
            data: vec![0x5A; 70],
        };
        let bytes = build(&frame);
        assert_eq!((bytes[0], bytes[3]), (0x80, 70));
        assert_eq!(parse(&bytes), Parsed::Frame(frame, bytes.len()));
    }

    #[test]
    fn incomplete_and_corrupt() {
        assert_eq!(parse(&[0x83, 0xF1, 0x12, 0xC1]), Parsed::Incomplete);
        assert_eq!(parse(&[0x81, 0x12, 0xF1, 0x81, 0x06]), Parsed::Invalid);
        assert_eq!(parse(&[0x55]), Parsed::Invalid);
    }
}
