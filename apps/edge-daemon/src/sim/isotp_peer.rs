//! ECU side of ISO 15765-2 (ISO-TP) for the virtual CAN bus.
//!
//! Receives single-frame and multi-frame requests (answering a First Frame with
//! Flow Control CTS, BS 0, STmin 0) and sends responses as a Single Frame or a
//! First Frame followed by Consecutive Frames paced by the tester's Flow Control
//! (BlockSize and STmin honoured). Supports one address byte for BMW extended
//! addressing.

/// A frame the peer wants on the bus, `at_us` after the triggering frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub at_us: u64,
    /// Full 8-byte CAN payload, address byte included.
    pub payload: Vec<u8>,
}

#[derive(Debug)]
struct Rx {
    len: usize,
    data: Vec<u8>,
    next_sn: u8,
}

#[derive(Debug)]
struct Tx {
    data: Vec<u8>,
    offset: usize,
    sn: u8,
}

/// ECU-side ISO-TP endpoint.
#[derive(Debug)]
pub struct IsoTpPeer {
    /// Address byte prepended to every frame this ECU sends (BMW: tester 0xF1).
    tx_prefix: Option<u8>,
    pad: u8,
    rx: Option<Rx>,
    tx: Option<Tx>,
}

/// STmin byte to microseconds (ISO 15765-2: 0–127 ms, 0xF1–0xF9 = 100–900 µs).
pub fn stmin_us(st: u8) -> u64 {
    match st {
        0x00..=0x7F => u64::from(st) * 1_000,
        0xF1..=0xF9 => u64::from(st - 0xF0) * 100,
        _ => 127_000,
    }
}

impl IsoTpPeer {
    pub fn new(tx_prefix: Option<u8>, pad: u8) -> Self {
        Self {
            tx_prefix,
            pad,
            rx: None,
            tx: None,
        }
    }

    fn data_room(&self) -> usize {
        7 - usize::from(self.tx_prefix.is_some())
    }

    fn frame(&self, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(8);
        out.extend(self.tx_prefix);
        out.extend_from_slice(body);
        out.resize(8, self.pad);
        out
    }

    /// True while a multi-frame response waits for Flow Control.
    pub fn is_sending(&self) -> bool {
        self.tx.is_some()
    }

    /// Handles one frame from the tester (address byte already removed).
    /// Returns a completed request, if any, and frames to send.
    pub fn on_frame(&mut self, pdu: &[u8]) -> (Option<Vec<u8>>, Vec<Outgoing>) {
        let Some(&pci) = pdu.first() else {
            return (None, Vec::new());
        };
        match pci >> 4 {
            0x0 => {
                let len = usize::from(pci & 0x0F);
                if len == 0 || len > pdu.len() - 1 {
                    return (None, Vec::new());
                }
                self.rx = None;
                (Some(pdu[1..=len].to_vec()), Vec::new())
            }
            0x1 if pdu.len() >= 2 => {
                let len = (usize::from(pci & 0x0F) << 8) | usize::from(pdu[1]);
                if len <= self.data_room() {
                    return (None, Vec::new());
                }
                self.rx = Some(Rx {
                    len,
                    data: pdu[2..].to_vec(),
                    next_sn: 1,
                });
                let fc = self.frame(&[0x30, 0x00, 0x00]);
                (
                    None,
                    vec![Outgoing {
                        at_us: 0,
                        payload: fc,
                    }],
                )
            }
            0x2 => {
                let Some(rx) = self.rx.as_mut() else {
                    return (None, Vec::new());
                };
                if pci & 0x0F != rx.next_sn {
                    self.rx = None; // sequence error: drop the message
                    return (None, Vec::new());
                }
                rx.data.extend_from_slice(&pdu[1..]);
                rx.next_sn = (rx.next_sn + 1) & 0x0F;
                if rx.data.len() >= rx.len {
                    let mut rx = self.rx.take().expect("checked above");
                    rx.data.truncate(rx.len);
                    return (Some(rx.data), Vec::new());
                }
                (None, Vec::new())
            }
            0x3 if pdu.len() >= 3 => (None, self.on_flow_control(pci & 0x0F, pdu[1], pdu[2])),
            _ => (None, Vec::new()),
        }
    }

    fn on_flow_control(&mut self, status: u8, block_size: u8, st: u8) -> Vec<Outgoing> {
        if status == 0x2 {
            self.tx = None; // overflow: abort
        }
        if status != 0x0 {
            return Vec::new(); // WAIT: the tester will send another FC
        }
        let room = self.data_room();
        let gap = stmin_us(st);
        let mut out = Vec::new();
        let mut sent = 0usize;
        loop {
            let Some(tx) = self.tx.as_mut() else { break };
            if tx.offset >= tx.data.len() || (block_size != 0 && sent == usize::from(block_size)) {
                break;
            }
            let end = (tx.offset + room).min(tx.data.len());
            let mut body = vec![0x20 | tx.sn];
            body.extend_from_slice(&tx.data[tx.offset..end]);
            tx.offset = end;
            tx.sn = (tx.sn + 1) & 0x0F;
            let at_us = gap * sent as u64;
            out.push(Outgoing {
                at_us,
                payload: self.frame(&body),
            });
            sent += 1;
        }
        if self
            .tx
            .as_ref()
            .is_some_and(|tx| tx.offset >= tx.data.len())
        {
            self.tx = None;
        }
        out
    }

    /// Starts sending a response: a Single Frame, or a First Frame that waits for FC.
    pub fn send(&mut self, data: &[u8]) -> Outgoing {
        let room = self.data_room();
        if data.len() <= room {
            self.tx = None;
            let mut body = vec![data.len() as u8];
            body.extend_from_slice(data);
            return Outgoing {
                at_us: 0,
                payload: self.frame(&body),
            };
        }
        let first = room - 1;
        let mut body = vec![0x10 | ((data.len() >> 8) as u8 & 0x0F), data.len() as u8];
        body.extend_from_slice(&data[..first]);
        self.tx = Some(Tx {
            data: data.to_vec(),
            offset: first,
            sn: 1,
        });
        Outgoing {
            at_us: 0,
            payload: self.frame(&body),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_frame_round_trip() {
        let mut peer = IsoTpPeer::new(None, 0xAA);
        let (req, out) = peer.on_frame(&[0x02, 0x10, 0x03, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]);
        assert_eq!((req, out.len()), (Some(vec![0x10, 0x03]), 0));
        let sf = peer.send(&[0x50, 0x03]);
        assert_eq!(
            sf.payload,
            vec![0x02, 0x50, 0x03, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA]
        );
    }

    #[test]
    fn multi_frame_response_honours_block_size_and_stmin() {
        let mut peer = IsoTpPeer::new(None, 0x00);
        let data: Vec<u8> = (0..30).collect(); // FF (6) + 4 CFs (7 each)
        let ff = peer.send(&data);
        assert_eq!(&ff.payload[..2], &[0x10, 30]);
        // BS 2, STmin 5 ms: two CFs 5 ms apart, then wait for the next FC.
        let (_, block) = peer.on_frame(&[0x30, 0x02, 0x05]);
        assert_eq!(block.len(), 2);
        assert_eq!((block[0].at_us, block[1].at_us), (0, 5_000));
        assert_eq!(block[0].payload[0], 0x21);
        assert!(peer.is_sending());
        // BS 0, STmin 500 µs: the rest.
        let (_, rest) = peer.on_frame(&[0x30, 0x00, 0xF5]);
        assert_eq!(rest.len(), 2);
        assert_eq!(
            (rest[0].payload[0], rest[1].payload[0], rest[1].at_us),
            (0x23, 0x24, 500)
        );
        assert!(!peer.is_sending());
        let mut got = ff.payload[2..].to_vec();
        for f in block.iter().chain(&rest) {
            got.extend_from_slice(&f.payload[1..]);
        }
        got.truncate(30);
        assert_eq!(got, data);
    }

    #[test]
    fn multi_frame_request_with_extended_address() {
        let mut peer = IsoTpPeer::new(Some(0xF1), 0xFF);
        let (_, fc) = peer.on_frame(&[0x10, 0x08, 1, 2, 3, 4, 5]);
        assert_eq!(
            fc[0].payload,
            vec![0xF1, 0x30, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF]
        );
        let (req, _) = peer.on_frame(&[0x21, 6, 7, 8, 0xFF, 0xFF, 0xFF]);
        assert_eq!(req, Some(vec![1, 2, 3, 4, 5, 6, 7, 8]));
        // With an address byte, a Single Frame carries at most 6 bytes.
        assert_eq!(peer.send(&[1, 2, 3, 4, 5, 6]).payload[1], 0x06);
        assert_eq!(peer.send(&[1, 2, 3, 4, 5, 6, 7]).payload[1], 0x10);
    }

    #[test]
    fn stmin_encoding() {
        assert_eq!(stmin_us(0x0A), 10_000);
        assert_eq!(stmin_us(0xF3), 300);
        assert_eq!(stmin_us(0x80), 127_000);
    }
}
