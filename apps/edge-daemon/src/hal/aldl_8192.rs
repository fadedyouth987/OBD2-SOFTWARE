//! GM 8192-baud ALDL adapter for pre-OBD-II Holden Commodores (VN-VY V6, 1988-2004).
//!
//! Frame layout: `[device_id, 0x55 + payload_len, mode, ...data, checksum]`
//! where `checksum = 0u8.wrapping_sub(sum(bytes))` (two's-complement sum == 0).

use std::time::Duration;

use async_trait::async_trait;

use super::{serial::SerialLink, HalError, Result};

pub const ALDL_BAUD: u32 = 8192;
pub const ALDL_ECM_ID: u8 = 0xF4;

/// Computes the GM ALDL two's-complement checksum byte.
pub fn aldl_checksum(frame_without_cs: &[u8]) -> u8 {
    let sum = frame_without_cs
        .iter()
        .fold(0u8, |acc, &b| acc.wrapping_add(b));
    0u8.wrapping_sub(sum)
}

/// Builds a complete ALDL request frame with length byte (`0x55 + body_len`) and checksum.
pub fn encode_aldl_frame(device_id: u8, mode: u8, data: &[u8]) -> Vec<u8> {
    let len_byte = 0x55u8.wrapping_add(1 + data.len() as u8);
    let mut frame = Vec::with_capacity(4 + data.len());
    frame.push(device_id);
    frame.push(len_byte);
    frame.push(mode);
    frame.extend_from_slice(data);
    frame.push(aldl_checksum(&frame));
    frame
}

/// Validates and strips the header + checksum from a received ALDL frame, returning `(mode, payload)`.
pub fn decode_aldl_frame(raw: &[u8]) -> Result<(u8, Vec<u8>)> {
    if raw.len() < 4 {
        return Err(HalError::Protocol("short ALDL frame".into()));
    }
    let body_len = usize::from(raw[1].saturating_sub(0x55));
    if raw.len() < 3 + body_len {
        return Err(HalError::Protocol("truncated ALDL frame".into()));
    }
    let total = 3 + body_len;
    let sum = raw[..total].iter().fold(0u8, |acc, &b| acc.wrapping_add(b));
    if sum != 0 {
        return Err(HalError::Protocol("ALDL checksum mismatch".into()));
    }
    Ok((raw[2], raw[3..total - 1].to_vec()))
}

/// Half-duplex 8192-baud ALDL adapter over any [`SerialLink`] (FTDI USB-ALDL or ReplaySerial).
pub struct Aldl8192Adapter<L: SerialLink> {
    link: L,
    open: bool,
}

impl<L: SerialLink> Aldl8192Adapter<L> {
    pub fn new(link: L) -> Self {
        Self { link, open: false }
    }

    pub async fn open(&mut self) -> Result<()> {
        self.link.set_baud(ALDL_BAUD).await?;
        self.link.clear_input().await?;
        self.open = true;
        Ok(())
    }

    /// Sends an ALDL request, strips the single-wire echo, and returns the decoded ECU reply.
    pub async fn request(&mut self, device_id: u8, mode: u8, data: &[u8]) -> Result<(u8, Vec<u8>)> {
        if !self.open {
            return Err(HalError::NotOpen);
        }
        let tx = encode_aldl_frame(device_id, mode, data);
        self.link.write_all(&tx).await?;
        let mut buf = [0u8; 128];
        let n = self.link.read(&mut buf, Duration::from_millis(300)).await?;
        let rx = if n >= tx.len() && buf[..tx.len()] == tx[..] {
            &buf[tx.len()..n]
        } else {
            &buf[..n]
        };
        decode_aldl_frame(rx)
    }

    pub async fn close(&mut self) -> Result<()> {
        self.open = false;
        Ok(())
    }
}

#[async_trait]
pub trait AldlTransport: Send {
    async fn read_mode1(&mut self) -> Result<Vec<u8>>;
    async fn clear_dtcs(&mut self) -> Result<()>;
}

#[async_trait]
impl<L: SerialLink> AldlTransport for Aldl8192Adapter<L> {
    async fn read_mode1(&mut self) -> Result<Vec<u8>> {
        let (_, payload) = self.request(ALDL_ECM_ID, 0x01, &[0x00]).await?;
        Ok(payload)
    }

    async fn clear_dtcs(&mut self) -> Result<()> {
        let _ = self.request(ALDL_ECM_ID, 0x0A, &[]).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aldl_encode_decode_round_trip() {
        let frame = encode_aldl_frame(ALDL_ECM_ID, 0x01, &[0x00]);
        assert_eq!(frame.iter().fold(0u8, |a, &b| a.wrapping_add(b)), 0);
        let (mode, data) = decode_aldl_frame(&frame).unwrap();
        assert_eq!((mode, data), (0x01, vec![0x00]));
    }
}
