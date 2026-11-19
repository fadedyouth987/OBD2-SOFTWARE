//! Linux SocketCAN adapter (Task 1.1): native CAN interfaces such as `can0`
//! (PCAN-USB, CANable in candleLight mode, Raspberry Pi CAN HATs) and `vcan0`.
//!
//! The kernel owns the bitrate: configure it with
//! `ip link set can0 type can bitrate 500000 && ip link set can0 up`. `open`
//! records the requested bitrate for logging only. Acceptance filters are
//! installed in the kernel, so unwanted traffic never reaches user space.

use std::time::Duration;

use async_trait::async_trait;
use socketcan::{EmbeddedFrame, ExtendedId, Id, SocketOptions, StandardId};

use super::{CanFilter, CanFrame, HalError, Result, VehicleBusAdapter};

const CAN_EFF_FLAG: u32 = 0x8000_0000;

/// Converts a HAL frame to a socketcan frame.
pub fn to_socketcan(frame: &CanFrame) -> Result<socketcan::CanFrame> {
    let id: Id = if frame.is_extended() {
        ExtendedId::new(frame.id()).map(Id::Extended)
    } else {
        StandardId::new(frame.id() as u16).map(Id::Standard)
    }
    .ok_or_else(|| HalError::InvalidFrame(format!("id {:#X}", frame.id())))?;
    socketcan::CanFrame::new(id, frame.data())
        .ok_or_else(|| HalError::InvalidFrame("payload".into()))
}

/// Converts a received socketcan frame; remote and error frames yield `None`.
pub fn from_socketcan(frame: &socketcan::CanFrame) -> Option<CanFrame> {
    let socketcan::CanFrame::Data(data) = frame else {
        return None;
    };
    let (id, extended) = match data.id() {
        Id::Standard(s) => (u32::from(s.as_raw()), false),
        Id::Extended(e) => (e.as_raw(), true),
    };
    CanFrame::new(id, extended, data.data()).ok()
}

/// Kernel filter for a HAL filter; the EFF flag in the mask makes the width part of the match.
pub fn kernel_filter(filter: &CanFilter) -> socketcan::CanFilter {
    let id = filter.id | if filter.extended { CAN_EFF_FLAG } else { 0 };
    socketcan::CanFilter::new(id, filter.mask | CAN_EFF_FLAG)
}

/// One SocketCAN interface.
pub struct SocketCanAdapter {
    ifname: String,
    socket: Option<socketcan::tokio::CanSocket>,
}

impl SocketCanAdapter {
    pub fn new(ifname: impl Into<String>) -> Self {
        Self {
            ifname: ifname.into(),
            socket: None,
        }
    }

    fn socket(&self) -> Result<&socketcan::tokio::CanSocket> {
        self.socket.as_ref().ok_or(HalError::NotOpen)
    }
}

#[async_trait]
impl VehicleBusAdapter for SocketCanAdapter {
    async fn open(&mut self, bitrate: u32) -> Result<()> {
        let socket = socketcan::tokio::CanSocket::open(&self.ifname)?;
        tracing::info!(ifname = %self.ifname, bitrate, "SocketCAN open (bitrate is set with `ip link`)");
        self.socket = Some(socket);
        Ok(())
    }

    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()> {
        let socket = self.socket()?;
        if filters.is_empty() {
            socket.set_filter_accept_all()?;
        } else {
            let kernel: Vec<socketcan::CanFilter> = filters.iter().map(kernel_filter).collect();
            socket.set_filters(&kernel)?;
        }
        Ok(())
    }

    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
        let out = to_socketcan(frame)?;
        self.socket()?.write_frame(out).await?;
        Ok(())
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        let socket = self.socket()?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let frame = tokio::time::timeout_at(deadline, socket.read_frame())
                .await
                .map_err(|_| HalError::Timeout(timeout))??;
            if let Some(frame) = from_socketcan(&frame) {
                return Ok(frame);
            }
        }
    }

    async fn close(&mut self) -> Result<()> {
        self.socket = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_conversion_round_trip() {
        for frame in [
            CanFrame::std(0x7E8, &[0x03, 0x41, 0x0D, 0x00]),
            CanFrame::ext(0x18DA_F110, &[1, 2, 3]),
        ] {
            assert_eq!(from_socketcan(&to_socketcan(&frame).unwrap()), Some(frame));
        }
    }

    #[test]
    fn kernel_filters_include_id_width() {
        let std = kernel_filter(&CanFilter::exact(0x7E8, false));
        let ext = kernel_filter(&CanFilter::exact(0x7E8, true));
        assert_ne!(format!("{std:?}"), format!("{ext:?}"));
    }

    /// Needs a vcan interface: `ip link add dev vcan0 type vcan && ip link set vcan0 up`.
    /// Run with `cargo test -p edge-daemon -- --ignored socketcan`.
    #[tokio::test]
    #[ignore = "needs vcan0"]
    async fn vcan_round_trip() {
        let mut a = SocketCanAdapter::new("vcan0");
        let mut b = SocketCanAdapter::new("vcan0");
        a.open(500_000).await.unwrap();
        b.open(500_000).await.unwrap();
        b.set_filter(&[CanFilter::exact(0x123, false)])
            .await
            .unwrap();
        a.send_frame(&CanFrame::std(0x321, &[9])).await.unwrap();
        a.send_frame(&CanFrame::std(0x123, &[1, 2])).await.unwrap();
        assert_eq!(
            b.recv_frame(Duration::from_millis(200)).await.unwrap(),
            CanFrame::std(0x123, &[1, 2])
        );
    }
}
