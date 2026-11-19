//! KWP2000 (ISO 14230-3) client helpers (Task 1.2): 0x10, 0x18, 0x1A, 0x21,
//! 0x22, 0x27, 0x30, 0x31, 0x3E. Gated services take a safety token.

use super::{positive, DiagError, DiagTransport};
use crate::protocol::messages::DiagProtocol;

const P: DiagProtocol = DiagProtocol::Kwp2000;

pub const SESSION_DEFAULT: u8 = 0x81;
pub const SESSION_PROGRAMMING: u8 = 0x85;
/// BMW-style extended diagnostic session.
pub const SESSION_EXTENDED: u8 = 0x89;

/// A KWP2000 trouble code (two bytes) and its status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KwpDtc {
    pub code: u16,
    pub status: u8,
}

pub struct Kwp<'a, T: DiagTransport + ?Sized>(pub &'a mut T);

impl<T: DiagTransport + ?Sized> Kwp<'_, T> {
    /// 0x10 StartDiagnosticSession (0x85 programming is gated).
    pub async fn start_session(
        &mut self,
        session: u8,
        token: Option<&str>,
    ) -> Result<(), DiagError> {
        positive(self.0, P, &[0x10, session], token, 2)
            .await
            .map(|_| ())
    }

    /// 0x3E TesterPresent.
    pub async fn tester_present(&mut self) -> Result<(), DiagError> {
        positive(self.0, P, &[0x3E], None, 1).await.map(|_| ())
    }

    /// 0x18 ReadDiagnosticTroubleCodesByStatus for all groups.
    pub async fn read_dtcs(&mut self, status: u8) -> Result<Vec<KwpDtc>, DiagError> {
        let resp = positive(self.0, P, &[0x18, status, 0xFF, 0x00], None, 2).await?;
        let count = usize::from(resp[1]);
        let dtcs: Vec<KwpDtc> = resp[2..]
            .chunks_exact(3)
            .map(|c| KwpDtc {
                code: u16::from_be_bytes([c[0], c[1]]),
                status: c[2],
            })
            .collect();
        if dtcs.len() != count {
            return Err(DiagError::Unexpected(format!(
                "ECU announced {count} DTCs, sent {}",
                dtcs.len()
            )));
        }
        Ok(dtcs)
    }

    /// 0x1A ReadECUIdentification.
    pub async fn read_ecu_identification(&mut self, id: u8) -> Result<Vec<u8>, DiagError> {
        let resp = positive(self.0, P, &[0x1A, id], None, 2).await?;
        Ok(resp[2..].to_vec())
    }

    /// 0x21 ReadDataByLocalIdentifier.
    pub async fn read_local_id(&mut self, id: u8) -> Result<Vec<u8>, DiagError> {
        let resp = positive(self.0, P, &[0x21, id], None, 2).await?;
        Ok(resp[2..].to_vec())
    }

    /// 0x22 ReadDataByCommonIdentifier.
    pub async fn read_common_id(&mut self, id: u16) -> Result<Vec<u8>, DiagError> {
        let [hi, lo] = id.to_be_bytes();
        let resp = positive(self.0, P, &[0x22, hi, lo], None, 3).await?;
        Ok(resp[3..].to_vec())
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

    /// 0x27 sendKey for the seed `level`. Gated.
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

    /// 0x30 InputOutputControlByLocalIdentifier. Gated.
    pub async fn io_control_local(
        &mut self,
        id: u8,
        params: &[u8],
        token: Option<&str>,
    ) -> Result<Vec<u8>, DiagError> {
        let mut req = vec![0x30, id];
        req.extend_from_slice(params);
        let resp = positive(self.0, P, &req, token, 2).await?;
        Ok(resp[2..].to_vec())
    }

    /// 0x31 StartRoutineByLocalIdentifier. Gated.
    pub async fn start_routine_local(
        &mut self,
        id: u8,
        params: &[u8],
        token: Option<&str>,
    ) -> Result<Vec<u8>, DiagError> {
        let mut req = vec![0x31, id];
        req.extend_from_slice(params);
        let resp = positive(self.0, P, &req, token, 2).await?;
        Ok(resp[2..].to_vec())
    }
}
