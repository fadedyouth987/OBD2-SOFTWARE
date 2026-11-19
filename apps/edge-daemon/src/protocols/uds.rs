//! UDS (ISO 14229-1) client helpers (Task 1.2): 0x10, 0x19, 0x22, 0x27, 0x2F,
//! 0x31, 0x3E. Gated services take a safety token; the interlock decides.

use std::time::Duration;

use super::{positive, DiagError, DiagTransport};
use crate::protocol::messages::DiagProtocol;

const P: DiagProtocol = DiagProtocol::Uds;

pub const SESSION_DEFAULT: u8 = 0x01;
pub const SESSION_PROGRAMMING: u8 = 0x02;
pub const SESSION_EXTENDED: u8 = 0x03;

/// Timing the ECU reports in its DiagnosticSessionControl response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionTiming {
    pub p2: Duration,
    pub p2_star: Duration,
}

/// A UDS trouble code: 3 bytes (J2012 code + failure type) and status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UdsDtc {
    pub code: u32,
    pub status: u8,
}

impl UdsDtc {
    /// e.g. "P0171-00".
    pub fn display(&self) -> String {
        format!(
            "{}-{:02X}",
            format_dtc((self.code >> 8) as u16),
            self.code & 0xFF
        )
    }
}

/// SAE J2012 two-byte DTC to text, e.g. 0x0171 -> "P0171", 0x5145 -> "C1145".
pub fn format_dtc(code: u16) -> String {
    let system = ['P', 'C', 'B', 'U'][usize::from(code >> 14)];
    format!("{system}{}{:03X}", (code >> 12) & 0x3, code & 0x0FFF)
}

/// UDS client over any transport.
pub struct Uds<'a, T: DiagTransport + ?Sized>(pub &'a mut T);

impl<T: DiagTransport + ?Sized> Uds<'_, T> {
    /// 0x10. Returns the ECU's timing (None if the response was suppressed).
    pub async fn session_control(
        &mut self,
        session: u8,
        token: Option<&str>,
    ) -> Result<Option<SessionTiming>, DiagError> {
        let resp = positive(self.0, P, &[0x10, session], token, 2).await?;
        Ok(match resp.as_slice() {
            [_, _, p2h, p2l, sh, sl, ..] => Some(SessionTiming {
                p2: Duration::from_millis(u64::from(u16::from_be_bytes([*p2h, *p2l]))),
                p2_star: Duration::from_millis(u64::from(u16::from_be_bytes([*sh, *sl])) * 10),
            }),
            _ => None,
        })
    }

    /// 0x3E TesterPresent.
    pub async fn tester_present(&mut self, suppress: bool) -> Result<(), DiagError> {
        positive(
            self.0,
            P,
            &[0x3E, if suppress { 0x80 } else { 0x00 }],
            None,
            1,
        )
        .await
        .map(|_| ())
    }

    /// 0x22 ReadDataByIdentifier, one DID.
    pub async fn read_did(&mut self, did: u16) -> Result<Vec<u8>, DiagError> {
        let [hi, lo] = did.to_be_bytes();
        let resp = positive(self.0, P, &[0x22, hi, lo], None, 3).await?;
        if resp[1..3] != [hi, lo] {
            return Err(DiagError::Unexpected(format!(
                "answer for DID {:02X}{:02X}, asked {did:04X}",
                resp[1], resp[2]
            )));
        }
        Ok(resp[3..].to_vec())
    }

    /// 0x19 0x02 reportDTCByStatusMask.
    pub async fn read_dtcs(&mut self, mask: u8) -> Result<Vec<UdsDtc>, DiagError> {
        let resp = positive(self.0, P, &[0x19, 0x02, mask], None, 3).await?;
        Ok(resp[3..]
            .chunks_exact(4)
            .map(|c| UdsDtc {
                code: u32::from_be_bytes([0, c[0], c[1], c[2]]),
                status: c[3],
            })
            .collect())
    }

    /// 0x19 0x01 reportNumberOfDTCByStatusMask.
    pub async fn dtc_count(&mut self, mask: u8) -> Result<u16, DiagError> {
        let resp = positive(self.0, P, &[0x19, 0x01, mask], None, 6).await?;
        Ok(u16::from_be_bytes([resp[4], resp[5]]))
    }

    /// 0x27 requestSeed (odd `level`). Gated.
    pub async fn request_seed(
        &mut self,
        level: u8,
        token: Option<&str>,
    ) -> Result<Vec<u8>, DiagError> {
        let resp = positive(self.0, P, &[0x27, level], token, 2).await?;
        Ok(resp[2..].to_vec())
    }

    /// 0x27 sendKey for the seed `level` (sends `level + 1`). Gated.
    pub async fn send_key(
        &mut self,
        level: u8,
        key: &[u8],
        token: Option<&str>,
    ) -> Result<(), DiagError> {
        let mut req = vec![0x27, level + 1];
        req.extend_from_slice(key);
        positive(self.0, P, &req, token, 2).await.map(|_| ())
    }

    /// 0x2F InputOutputControlByIdentifier. Gated. Returns the control status record.
    pub async fn io_control(
        &mut self,
        did: u16,
        control: u8,
        state: &[u8],
        token: Option<&str>,
    ) -> Result<Vec<u8>, DiagError> {
        let [hi, lo] = did.to_be_bytes();
        let mut req = vec![0x2F, hi, lo, control];
        req.extend_from_slice(state);
        let resp = positive(self.0, P, &req, token, 4).await?;
        Ok(resp[4..].to_vec())
    }

    /// 0x31 RoutineControl (sub 0x01 start, 0x02 stop, 0x03 results). Gated.
    /// Returns the routine status record.
    pub async fn routine_control(
        &mut self,
        sub: u8,
        rid: u16,
        data: &[u8],
        token: Option<&str>,
    ) -> Result<Vec<u8>, DiagError> {
        let [hi, lo] = rid.to_be_bytes();
        let mut req = vec![0x31, sub, hi, lo];
        req.extend_from_slice(data);
        let resp = positive(self.0, P, &req, token, 4).await?;
        Ok(resp[4..].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dtc_text() {
        assert_eq!(format_dtc(0x0171), "P0171");
        assert_eq!(format_dtc(0x5145), "C1145");
        assert_eq!(format_dtc(0x9234), "B1234");
        assert_eq!(format_dtc(0xC100), "U0100");
        assert_eq!(
            UdsDtc {
                code: 0x01_71_13,
                status: 0x08
            }
            .display(),
            "P0171-13"
        );
    }
}
