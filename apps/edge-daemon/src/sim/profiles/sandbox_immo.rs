//! Sandbox on-board add-key profile for Phase 1 tests.
//!
//! The IMMO ECU accepts only the well-known sandbox OEM token
//! (`crate::immo::SANDBOX_KEY`). It does not implement an OEM seed/key
//! algorithm: the key function ignores the seed.

use super::{CanAddr, EcuNode, Link, Profile};
use crate::immo::{
    sandbox_token_key, SANDBOX_ECU_RX, SANDBOX_ECU_TX, SANDBOX_PROFILE_ID, SANDBOX_VIN,
};
use crate::sim::{
    ecu::{Dialect, EcuSpec, SecuritySpec},
    VehicleState,
};

pub const ID: &str = SANDBOX_PROFILE_ID;
pub const ENGINE_REQ: u32 = 0x7E0;
pub const ENGINE_RESP: u32 = 0x7E8;
pub const IMMO_REQ: u32 = SANDBOX_ECU_TX;
pub const IMMO_RESP: u32 = SANDBOX_ECU_RX;

fn engine_spec() -> EcuSpec {
    let mut spec = EcuSpec::new("ENGINE", Dialect::Uds);
    spec.obd = true;
    spec.obd_pids = vec![0x0C, 0x0D, 0x42];
    spec
}

fn immo_spec() -> EcuSpec {
    let mut spec = EcuSpec::new("SANDBOX_IMMO", Dialect::Uds);
    spec.security = Some(SecuritySpec {
        seed_len: 8,
        key: sandbox_token_key,
        max_attempts: 3,
        lockout_ms: 10_000,
    });
    spec
}

pub fn profile() -> Profile {
    // Maintainer connected: battery above the immobilizer voltage floor.
    let vehicle = VehicleState {
        vin: SANDBOX_VIN.into(),
        speed_kmh: 0.0,
        rpm: 0.0,
        battery_v: 13.8,
        ..VehicleState::default()
    };
    Profile {
        id: ID,
        name: "Sandbox on-board add-key (simulated, not an OEM)",
        link: Link::Can { bitrate: 500_000 },
        ecus: vec![
            EcuNode {
                spec: engine_spec(),
                can: vec![
                    CanAddr::Normal {
                        req: ENGINE_REQ,
                        resp: ENGINE_RESP,
                    },
                    CanAddr::Functional { resp: ENGINE_RESP },
                ],
                kline: None,
            },
            EcuNode {
                spec: immo_spec(),
                can: vec![CanAddr::Normal {
                    req: IMMO_REQ,
                    resp: IMMO_RESP,
                }],
                kline: None,
            },
        ],
        periodic: vec![],
        vehicle,
        isotp_pad: 0xAA,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::immo::SANDBOX_KEY;
    use crate::sim::ecu::EcuSim;

    fn one(replies: Vec<crate::sim::ecu::Reply>) -> Vec<u8> {
        replies.into_iter().next().unwrap().data
    }

    #[test]
    fn sandbox_immo_accepts_oem_token_only() {
        let mut ecu = EcuSim::new(immo_spec());
        let mut v = VehicleState::default();
        // Extended session first (required by many security implementations).
        let _ = ecu.handle(0, &[0x10, 0x03], &mut v);
        let seed = one(ecu.handle(0, &[0x27, 0x01], &mut v));
        assert_eq!(seed[0], 0x67);
        let mut key = vec![0x27, 0x02];
        key.extend_from_slice(SANDBOX_KEY);
        let ok = one(ecu.handle(0, &key, &mut v));
        assert_eq!(ok[0], 0x67, "{ok:?}");
        // Wrong bytes are not an algorithm; they are just the wrong token.
        let mut ecu = EcuSim::new(immo_spec());
        let _ = ecu.handle(0, &[0x10, 0x03], &mut v);
        let _ = ecu.handle(0, &[0x27, 0x01], &mut v);
        let bad = one(ecu.handle(0, &[0x27, 0x02, 0, 0, 0, 0, 0, 0, 0, 0], &mut v));
        assert_eq!(bad, vec![0x7F, 0x27, 0x35]);
    }
}
