//! Request loop shared by the PassThru backend and the loopback device.

use std::{
    collections::VecDeque,
    io::{BufRead, Write},
};

use crate::proto::{self, DeviceInfo, Filter, Request, Response, BRIDGE_PROTOCOL};

/// Line-delimited JSON transport.
pub struct Io<R: BufRead, W: Write> {
    reader: R,
    writer: W,
}

impl<R: BufRead, W: Write> Io<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self { reader, writer }
    }

    /// Next request; `None` at end of input. Unparseable lines are answered
    /// with an error here and skipped.
    pub fn next_request(&mut self) -> Option<Request> {
        loop {
            let mut line = String::new();
            if self.reader.read_line(&mut line).ok()? == 0 {
                return None;
            }
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str(&line) {
                Ok(req) => return Some(req),
                Err(e) => self.reply(&Response::Error {
                    message: format!("bad request: {e}"),
                }),
            }
        }
    }

    pub fn reply(&mut self, response: &Response) {
        let line = serde_json::to_string(response).expect("responses serialize");
        // A closed stdout means the daemon is gone; the next read ends the loop.
        let _ = writeln!(self.writer, "{line}").and_then(|()| self.writer.flush());
    }
}

pub fn hello() -> Response {
    Response::Hello {
        protocol: BRIDGE_PROTOCOL,
        version: env!("CARGO_PKG_VERSION").into(),
        pointer_bits: usize::BITS,
    }
}

/// Operations on an open CAN channel.
pub trait ChannelOps {
    fn set_filters(&mut self, filters: &[Filter]) -> Result<(), String>;
    fn send(&mut self, id: u32, extended: bool, data: &[u8]) -> Result<(), String>;
    /// `Ok(None)` on timeout.
    fn recv(&mut self, timeout_ms: u32) -> Result<Option<(u32, bool, Vec<u8>)>, String>;
}

/// Why a channel loop ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Exit {
    Disconnect,
    Close,
    Eof,
}

fn result(r: Result<(), String>) -> Response {
    r.map_or_else(|message| Response::Error { message }, |()| Response::Ok)
}

/// Serves channel-level requests until Disconnect, Close or end of input.
pub fn serve_channel<C: ChannelOps, R: BufRead, W: Write>(ch: &mut C, io: &mut Io<R, W>) -> Exit {
    while let Some(req) = io.next_request() {
        let response = match req {
            Request::Hello => hello(),
            Request::SetFilter { filters } => result(ch.set_filters(&filters)),
            Request::Send { id, extended, data } => {
                result(proto::unhex(&data).and_then(|d| ch.send(id, extended, &d)))
            }
            Request::Recv { timeout_ms } => match ch.recv(timeout_ms) {
                Ok(Some((id, extended, data))) => Response::Frame {
                    id,
                    extended,
                    data: proto::hex(&data),
                },
                Ok(None) => Response::Timeout,
                Err(message) => Response::Error { message },
            },
            Request::Disconnect => {
                io.reply(&Response::Ok);
                return Exit::Disconnect;
            }
            Request::Close => {
                io.reply(&Response::Ok);
                return Exit::Close;
            }
            other => Response::Error {
                message: format!("{other:?} is not valid while a channel is open"),
            },
        };
        io.reply(&response);
    }
    Exit::Eof
}

/// Serves device-level requests (Connect, Close). `connect` opens a channel at a bitrate.
/// Returns true at end of input.
pub fn serve_device<C, R, W>(
    io: &mut Io<R, W>,
    mut connect: impl FnMut(u32) -> Result<C, String>,
) -> bool
where
    C: ChannelOps,
    R: BufRead,
    W: Write,
{
    while let Some(req) = io.next_request() {
        match req {
            Request::Hello => io.reply(&hello()),
            Request::Connect { bitrate } => match connect(bitrate) {
                Ok(mut ch) => {
                    io.reply(&Response::Ok);
                    match serve_channel(&mut ch, io) {
                        Exit::Eof => return true,
                        Exit::Close => return false,
                        Exit::Disconnect => {}
                    }
                }
                Err(message) => io.reply(&Response::Error { message }),
            },
            Request::Close => {
                io.reply(&Response::Ok);
                return false;
            }
            other => io.reply(&Response::Error {
                message: format!("{other:?} needs an open channel"),
            }),
        }
    }
    true
}

/// Top level: Hello, List, Open. `open` loads a device and calls `serve_device`
/// itself (so the device can borrow the loaded DLL); it returns true at end of input.
pub fn serve<R: BufRead, W: Write>(
    io: &mut Io<R, W>,
    list: impl Fn() -> Result<Vec<DeviceInfo>, String>,
    mut open: impl FnMut(&str, &mut Io<R, W>) -> Result<bool, String>,
) {
    while let Some(req) = io.next_request() {
        match req {
            Request::Hello => io.reply(&hello()),
            Request::List => io.reply(&match list() {
                Ok(devices) => Response::Devices { devices },
                Err(message) => Response::Error { message },
            }),
            Request::Open { dll } => match open(&dll, io) {
                Ok(true) => return,
                Ok(false) => {}
                Err(message) => io.reply(&Response::Error { message }),
            },
            other => io.reply(&Response::Error {
                message: format!("{other:?} needs an open device"),
            }),
        }
    }
}

/// In-memory device for tests: sent frames come back on receive.
#[derive(Default)]
pub struct LoopbackChannel {
    queue: VecDeque<(u32, bool, Vec<u8>)>,
    filters: Vec<Filter>,
}

impl ChannelOps for LoopbackChannel {
    fn set_filters(&mut self, filters: &[Filter]) -> Result<(), String> {
        self.filters = filters.to_vec();
        Ok(())
    }

    fn send(&mut self, id: u32, extended: bool, data: &[u8]) -> Result<(), String> {
        let max = if extended { 0x1FFF_FFFF } else { 0x7FF };
        if id > max || data.len() > 8 {
            return Err(format!("invalid frame id {id:#X} len {}", data.len()));
        }
        self.queue.push_back((id, extended, data.to_vec()));
        Ok(())
    }

    fn recv(&mut self, _timeout_ms: u32) -> Result<Option<(u32, bool, Vec<u8>)>, String> {
        while let Some((id, extended, data)) = self.queue.pop_front() {
            let pass = self.filters.is_empty()
                || self
                    .filters
                    .iter()
                    .any(|f| f.extended == extended && id & f.mask == f.id & f.mask);
            if pass {
                return Ok(Some((id, extended, data)));
            }
        }
        Ok(None)
    }
}

pub const LOOPBACK_DLL: &str = "loopback";

/// Serves the loopback device.
pub fn run_loopback<R: BufRead, W: Write>(io: &mut Io<R, W>) {
    serve(
        io,
        || {
            Ok(vec![DeviceInfo {
                name: "Loopback (test)".into(),
                vendor: "edge-daemon".into(),
                dll: LOOPBACK_DLL.into(),
            }])
        },
        |dll, io| {
            if dll != LOOPBACK_DLL {
                return Err(format!("loopback mode has no DLL {dll:?}"));
            }
            io.reply(&Response::Ok);
            Ok(serve_device(io, |_bitrate| Ok(LoopbackChannel::default())))
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> Vec<Response> {
        let mut out = Vec::new();
        run_loopback(&mut Io::new(input.as_bytes(), &mut out));
        String::from_utf8(out)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn loopback_session() {
        let responses = run(concat!(
            r#"{"op":"hello"}"#,
            "\n",
            r#"{"op":"send","id":1,"extended":false,"data":""}"#,
            "\n",
            r#"{"op":"open","dll":"loopback"}"#,
            "\n",
            r#"{"op":"connect","bitrate":500000}"#,
            "\n",
            r#"{"op":"set_filter","filters":[{"id":2016,"mask":2047,"extended":false}]}"#,
            "\n",
            r#"{"op":"send","id":291,"extended":false,"data":"01"}"#,
            "\n",
            r#"{"op":"send","id":2016,"extended":false,"data":"023E00"}"#,
            "\n",
            r#"{"op":"recv","timeout_ms":10}"#,
            "\n",
            r#"{"op":"recv","timeout_ms":10}"#,
            "\n",
            "not json\n",
            r#"{"op":"close"}"#,
            "\n",
        ));
        assert!(matches!(
            responses[0],
            Response::Hello {
                protocol: BRIDGE_PROTOCOL,
                ..
            }
        ));
        assert!(
            matches!(responses[1], Response::Error { .. }),
            "send before open"
        );
        assert_eq!(
            &responses[2..7],
            &[
                Response::Ok,
                Response::Ok,
                Response::Ok,
                Response::Ok,
                Response::Ok
            ]
        );
        assert_eq!(
            responses[7],
            Response::Frame {
                id: 0x7E0,
                extended: false,
                data: "023E00".into()
            }
        );
        assert_eq!(responses[8], Response::Timeout, "0x123 was filtered out");
        assert!(matches!(responses[9], Response::Error { .. }));
        assert_eq!(responses[10], Response::Ok);
    }
}
