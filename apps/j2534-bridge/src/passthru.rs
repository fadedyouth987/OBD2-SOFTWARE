//! Real J2534 backend (Windows): loads a vendor DLL with the `j2534` crate.
//!
//! The registry lookup runs in this 32-bit process, so it reads the
//! WOW6432Node view where 32-bit PassThru drivers register.

use std::io::{BufRead, Write};

use j2534::{
    ConnectFlags, Error as J2534Error, FilterType, Interface, PassThruMsg, Protocol, RxStatus,
    TxFlags,
};

use crate::{
    proto::{DeviceInfo, Filter},
    serve::{serve, serve_device, ChannelOps, Io},
};

struct PassThruChannel<'a> {
    channel: j2534::Channel<'a>,
}

fn err(e: J2534Error) -> String {
    format!("J2534: {e}")
}

fn can_msg(id: u32, extended: bool, data: &[u8]) -> PassThruMsg {
    let flags = if extended {
        TxFlags::CAN_29BIT_ID
    } else {
        TxFlags::NONE
    };
    PassThruMsg::new_can(id, data).tx_flags(flags)
}

impl ChannelOps for PassThruChannel<'_> {
    fn set_filters(&mut self, filters: &[Filter]) -> Result<(), String> {
        self.channel.clear_message_filters().map_err(err)?;
        // A raw CAN channel receives nothing without at least one pass filter.
        let pass_all = [
            Filter {
                id: 0,
                mask: 0,
                extended: false,
            },
            Filter {
                id: 0,
                mask: 0,
                extended: true,
            },
        ];
        let list = if filters.is_empty() {
            &pass_all[..]
        } else {
            filters
        };
        for f in list {
            let mask = can_msg(f.mask, f.extended, &[]);
            let pattern = can_msg(f.id, f.extended, &[]);
            self.channel
                .start_message_filter(FilterType::Pass, Some(&mask), Some(&pattern), None)
                .map_err(err)?;
        }
        Ok(())
    }

    fn send(&mut self, id: u32, extended: bool, data: &[u8]) -> Result<(), String> {
        let mut msgs = [can_msg(id, extended, data)];
        self.channel.write(&mut msgs, 100).map_err(err)?;
        Ok(())
    }

    fn recv(&mut self, timeout_ms: u32) -> Result<Option<(u32, bool, Vec<u8>)>, String> {
        loop {
            match self.channel.read_once(timeout_ms) {
                Ok(msg) => {
                    let status = RxStatus::from_bits_truncate(msg.rx_status);
                    if status.contains(RxStatus::TX_MSG_TYPE) {
                        continue; // our own transmission echoed back
                    }
                    if let Some((id, data)) = msg.can_message() {
                        return Ok(Some((
                            id,
                            status.contains(RxStatus::CAN_29BIT_ID),
                            data.to_vec(),
                        )));
                    }
                }
                Err(J2534Error::Timeout | J2534Error::BufferEmpty) => return Ok(None),
                Err(e) => return Err(err(e)),
            }
        }
    }
}

fn list() -> Result<Vec<DeviceInfo>, String> {
    let drivers = j2534::drivers().map_err(|e| format!("registry: {e}"))?;
    Ok(drivers
        .into_iter()
        .map(|d| DeviceInfo {
            name: d.name,
            vendor: d.vendor,
            dll: d.path,
        })
        .collect())
}

/// Serves requests for real PassThru devices until stdin closes.
pub fn run<R: BufRead, W: Write>(io: &mut Io<R, W>) {
    serve(io, list, |dll, io| {
        let interface = Interface::new(dll).map_err(|e| format!("load {dll}: {e}"))?;
        let device = interface.open_any().map_err(err)?;
        io.reply(&crate::proto::Response::Ok);
        Ok(serve_device(io, |bitrate| {
            let channel = device
                .connect(Protocol::CAN, ConnectFlags::CAN_ID_BOTH, bitrate)
                .map_err(err)?;
            let mut ch = PassThruChannel { channel };
            ch.set_filters(&[])?;
            Ok(ch)
        }))
    });
}
