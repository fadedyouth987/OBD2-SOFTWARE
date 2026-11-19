//! Bridge wire protocol: one JSON object per line, one response per request.

use serde::{Deserialize, Serialize};

/// Bumped on any incompatible change; the daemon checks it in `Hello`.
pub const BRIDGE_PROTOCOL: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Filter {
    pub id: u32,
    pub mask: u32,
    pub extended: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub name: String,
    pub vendor: String,
    /// DLL path from the PassThruSupport.04.04 registry entry.
    pub dll: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Hello,
    /// Installed PassThru devices.
    List,
    /// Load a DLL and open its device (PassThruOpen).
    Open {
        dll: String,
    },
    /// Raw CAN channel (PassThruConnect, CAN, 11- and 29-bit ids).
    Connect {
        bitrate: u32,
    },
    /// Replace the pass filters; empty means pass everything.
    SetFilter {
        filters: Vec<Filter>,
    },
    /// `data` is hex, at most 8 bytes.
    Send {
        id: u32,
        extended: bool,
        data: String,
    },
    Recv {
        timeout_ms: u32,
    },
    Disconnect,
    /// Close the device (PassThruClose).
    Close,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Ok,
    Hello {
        protocol: u32,
        version: String,
        pointer_bits: u32,
    },
    Devices {
        devices: Vec<DeviceInfo>,
    },
    Frame {
        id: u32,
        extended: bool,
        data: String,
    },
    Timeout,
    Error {
        message: String,
    },
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

pub fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) || text.len() > 16 {
        return Err(format!("bad CAN payload {text:?}"));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| format!("bad hex {text:?}")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_format() {
        let req = Request::Send {
            id: 0x7E0,
            extended: false,
            data: "023E00".into(),
        };
        let line = serde_json::to_string(&req).unwrap();
        assert_eq!(
            line,
            r#"{"op":"send","id":2016,"extended":false,"data":"023E00"}"#
        );
        assert_eq!(serde_json::from_str::<Request>(&line).unwrap(), req);
        assert_eq!(
            serde_json::to_string(&Response::Timeout).unwrap(),
            r#"{"status":"timeout"}"#
        );
        assert_eq!(unhex("0A0B").unwrap(), vec![0x0A, 0x0B]);
        assert!(unhex("000102030405060708").is_err());
    }
}
