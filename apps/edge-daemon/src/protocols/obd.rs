//! SAE J1979 / ISO 15031-5 OBD client (Task 1.2): mode 0x01 PIDs with
//! decoding, stored/pending/permanent DTCs, VIN, and mode 0x04 (gated).

use super::{positive, uds::format_dtc, DiagError, DiagTransport};
use crate::protocol::messages::DiagProtocol;

const P: DiagProtocol = DiagProtocol::Obd;

/// A decoded mode 0x01 value.
#[derive(Clone, Debug, PartialEq)]
pub struct PidValue {
    pub pid: u8,
    pub name: &'static str,
    pub value: f64,
    pub unit: &'static str,
}

/// Data length of a mode 0x01 PID, for splitting multi-PID responses.
pub fn pid_len(pid: u8) -> Option<usize> {
    Some(match pid {
        0x00 | 0x20 | 0x40 | 0x60 | 0x01 => 4,
        0x04..=0x09 | 0x0B | 0x0D | 0x0E | 0x0F | 0x11 | 0x1C | 0x2F | 0x33 | 0x46 => 1,
        0x0C | 0x10 | 0x1F | 0x21 | 0x31 | 0x42 => 2,
        _ => return None,
    })
}

/// Decodes one PID (SAE J1979 formulas). Bitmap and status PIDs return `None`.
pub fn decode_pid(pid: u8, d: &[u8]) -> Option<PidValue> {
    let a = f64::from(*d.first()?);
    let ab = || d.get(1).map(|b| a * 256.0 + f64::from(*b));
    let trim = |name| (name, (a - 128.0) * 100.0 / 128.0, "%");
    let (name, value, unit) = match pid {
        0x04 => ("Engine load", a * 100.0 / 255.0, "%"),
        0x05 => ("Coolant temperature", a - 40.0, "°C"),
        0x06 => trim("Short-term fuel trim B1"),
        0x07 => trim("Long-term fuel trim B1"),
        0x08 => trim("Short-term fuel trim B2"),
        0x09 => trim("Long-term fuel trim B2"),
        0x0B => ("Intake manifold pressure", a, "kPa"),
        0x0C => ("Engine speed", ab()? / 4.0, "rpm"),
        0x0D => ("Vehicle speed", a, "km/h"),
        0x0E => ("Timing advance", a / 2.0 - 64.0, "°"),
        0x0F => ("Intake air temperature", a - 40.0, "°C"),
        0x10 => ("MAF air flow", ab()? / 100.0, "g/s"),
        0x11 => ("Throttle position", a * 100.0 / 255.0, "%"),
        0x1F => ("Run time since start", ab()?, "s"),
        0x21 => ("Distance with MIL on", ab()?, "km"),
        0x2F => ("Fuel level", a * 100.0 / 255.0, "%"),
        0x31 => ("Distance since codes cleared", ab()?, "km"),
        0x33 => ("Barometric pressure", a, "kPa"),
        0x42 => ("Control module voltage", ab()? / 1000.0, "V"),
        0x46 => ("Ambient air temperature", a - 40.0, "°C"),
        _ => return None,
    };
    Some(PidValue {
        pid,
        name,
        value,
        unit,
    })
}

/// Splits a mode 0x01 positive response into (pid, data) pairs.
pub fn split_pids(resp: &[u8]) -> Result<Vec<(u8, Vec<u8>)>, DiagError> {
    let mut out = Vec::new();
    let mut i = 1;
    while i < resp.len() {
        let pid = resp[i];
        let len = pid_len(pid)
            .ok_or_else(|| DiagError::Unexpected(format!("unknown length for PID {pid:#04X}")))?;
        let data = resp
            .get(i + 1..i + 1 + len)
            .ok_or_else(|| DiagError::Unexpected("truncated PID data".into()))?;
        out.push((pid, data.to_vec()));
        i += 1 + len;
    }
    Ok(out)
}

pub struct Obd<'a, T: DiagTransport + ?Sized>(pub &'a mut T);

impl<T: DiagTransport + ?Sized> Obd<'_, T> {
    /// Mode 0x01 with up to six PIDs; returns raw data per PID answered.
    pub async fn read_pids_raw(&mut self, pids: &[u8]) -> Result<Vec<(u8, Vec<u8>)>, DiagError> {
        let mut req = vec![0x01];
        req.extend_from_slice(pids);
        split_pids(&positive(self.0, P, &req, None, 1).await?)
    }

    /// Mode 0x01, decoded. PIDs without a numeric decoding are skipped.
    pub async fn read_pids(&mut self, pids: &[u8]) -> Result<Vec<PidValue>, DiagError> {
        Ok(self
            .read_pids_raw(pids)
            .await?
            .into_iter()
            .filter_map(|(p, d)| decode_pid(p, &d))
            .collect())
    }

    /// Supported mode 0x01 PIDs (walks 0x00, 0x20, 0x40...).
    pub async fn supported_pids(&mut self) -> Result<Vec<u8>, DiagError> {
        let mut out = Vec::new();
        let mut base = 0x00u8;
        loop {
            let raw = self.read_pids_raw(&[base]).await?;
            let Some((_, bits)) = raw.into_iter().find(|(p, _)| *p == base) else {
                break;
            };
            let bits = u32::from_be_bytes([bits[0], bits[1], bits[2], bits[3]]);
            for n in 1..=32u8 {
                if bits & (1 << (32 - n)) != 0 {
                    out.push(base + n);
                }
            }
            if bits & 1 == 0 || base == 0xE0 {
                break;
            }
            base += 0x20;
        }
        out.retain(|p| p % 0x20 != 0);
        Ok(out)
    }

    /// Mode 0x03 (stored), 0x07 (pending) or 0x0A (permanent) DTCs as text.
    pub async fn read_dtcs(&mut self, mode: u8) -> Result<Vec<String>, DiagError> {
        let resp = positive(self.0, P, &[mode], None, 1).await?;
        // CAN responses carry a count byte; K-line responses do not.
        let body = if (resp.len() - 1) % 2 == 1 {
            &resp[2..]
        } else {
            &resp[1..]
        };
        Ok(body
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .filter(|c| *c != 0)
            .map(format_dtc)
            .collect())
    }

    /// Mode 0x09 PID 0x02.
    pub async fn read_vin(&mut self) -> Result<String, DiagError> {
        let resp = positive(self.0, P, &[0x09, 0x02], None, 3).await?;
        let vin = resp.get(3..).unwrap_or_default();
        Ok(String::from_utf8_lossy(vin)
            .trim_matches(char::from(0))
            .to_owned())
    }

    /// Mode 0x04: clear DTCs and stored values. Gated.
    pub async fn clear_dtcs(&mut self, token: Option<&str>) -> Result<(), DiagError> {
        positive(self.0, P, &[0x04], token, 1).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_decoding_matches_j1979() {
        assert_eq!(decode_pid(0x0C, &[0x0C, 0xB2]).unwrap().value, 812.5);
        assert_eq!(decode_pid(0x05, &[0x5A]).unwrap().value, 50.0);
        assert_eq!(decode_pid(0x06, &[0x8F]).unwrap().value, 11.71875);
        assert_eq!(decode_pid(0x42, &[0x31, 0x38]).unwrap().value, 12.6);
        assert!(decode_pid(0x01, &[0, 0, 0, 0]).is_none());
        assert!(decode_pid(0x0C, &[0x0C]).is_none());
        let split = split_pids(&[0x41, 0x0C, 0x0C, 0xB2, 0x0D, 0x00]).unwrap();
        assert_eq!(split, vec![(0x0C, vec![0x0C, 0xB2]), (0x0D, vec![0x00])]);
        assert!(split_pids(&[0x41, 0x0C, 0x0C]).is_err());
    }
}
