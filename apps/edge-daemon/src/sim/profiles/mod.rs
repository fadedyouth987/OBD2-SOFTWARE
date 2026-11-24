//! Built-in virtual vehicles (Task 1.1), plus the sandbox IMMO profile.
//!
//! | Profile id | Vehicle | Link |
//! | --- | --- | --- |
//! | `bmw-e90-pre2007` | BMW E90 built before 03/2007: DME, CAS, DSC | K-line ISO 14230, 10.4 kbit/s, KWP2000 |
//! | `bmw-e90-dcan` | BMW E90 built 03/2007 on: DME, CAS, DSC | BMW D-CAN 500 kbit/s, extended addressing |
//! | `ford-falcon-ba` | Ford Falcon BA (2002–2005): PCM, IC, ABS | HS-CAN 500 kbit/s, 11-bit, ISO 15765-4 |
//! | `generic-uds` | Generic UDS engine ECU (2010+) | ISO 15765-4, 500 kbit/s, 11-bit |
//! | `sandbox-immo` | Sandbox on-board add-key (test only) | ISO 15765-4, 500 kbit/s, 11-bit |
//!
//! Identifiers, addresses and data are plausible stand-ins, not copies of any
//! manufacturer's data. Real-car captures arrive as fixtures under A-ENG-10.

use super::{ecu::EcuSpec, VehicleState};

pub mod e90_dcan;
pub mod e90_pre2007;
pub mod falcon_ba;
pub mod generic_uds;
pub mod sandbox_immo;

/// How an ECU is reached on CAN.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanAddr {
    /// ISO 15765-4 normal addressing: requests on `req`, responses on `resp`.
    Normal { req: u32, resp: u32 },
    /// Also answers functional OBD requests on 0x7DF, replying on `resp`.
    Functional { resp: u32 },
    /// BMW D-CAN: requests on 0x6F1 with first byte `ecu`; replies on
    /// 0x600 + `ecu` with first byte 0xF1 (the tester).
    BmwExtended { ecu: u8 },
}

pub const OBD_FUNCTIONAL_ID: u32 = 0x7DF;
pub const BMW_TESTER_ID: u32 = 0x6F1;
pub const BMW_TESTER_ADDR: u8 = 0xF1;
pub const BMW_RESPONSE_BASE: u32 = 0x600;
/// ISO 14230 functional address for OBD requests on K-line.
pub const KLINE_OBD_FUNCTIONAL: u8 = 0x33;
pub const KLINE_TESTER_ADDR: u8 = 0xF1;

/// One ECU and how to reach it.
#[derive(Clone, Debug)]
pub struct EcuNode {
    pub spec: EcuSpec,
    /// CAN addresses (empty for K-line ECUs).
    pub can: Vec<CanAddr>,
    /// K-line address (None for CAN ECUs).
    pub kline: Option<u8>,
}

/// The physical link a profile uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Link {
    Can { bitrate: u32 },
    KLine { baud: u32 },
}

/// A frame the vehicle broadcasts on its own (instrument data, switches).
#[derive(Clone, Copy, Debug)]
pub struct PeriodicFrame {
    pub id: u32,
    pub extended: bool,
    pub period_ms: u64,
    /// Payload from the vehicle state and a rolling counter.
    pub payload: fn(&VehicleState, u32) -> Vec<u8>,
}

/// A complete virtual vehicle.
#[derive(Clone, Debug)]
pub struct Profile {
    pub id: &'static str,
    pub name: &'static str,
    pub link: Link,
    pub ecus: Vec<EcuNode>,
    pub periodic: Vec<PeriodicFrame>,
    pub vehicle: VehicleState,
    /// ISO-TP padding byte the ECUs use.
    pub isotp_pad: u8,
}

/// Every built-in profile.
pub fn all() -> Vec<Profile> {
    vec![
        e90_pre2007::profile(),
        e90_dcan::profile(),
        falcon_ba::profile(),
        generic_uds::profile(),
        sandbox_immo::profile(),
    ]
}

/// A profile by id.
pub fn by_id(id: &str) -> Option<Profile> {
    all().into_iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_are_well_formed() {
        let profiles = all();
        assert_eq!(profiles.len(), 5);
        for p in &profiles {
            assert!(by_id(p.id).is_some());
            assert!(!p.ecus.is_empty(), "{}", p.id);
            for node in &p.ecus {
                match p.link {
                    Link::Can { .. } => assert!(
                        !node.can.is_empty() && node.kline.is_none(),
                        "{}",
                        node.spec.name
                    ),
                    Link::KLine { .. } => assert!(
                        node.can.is_empty() && node.kline.is_some(),
                        "{}",
                        node.spec.name
                    ),
                }
            }
        }
    }
}
