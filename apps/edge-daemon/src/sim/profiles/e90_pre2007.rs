//! BMW E90 built before 03/2007: DME, CAS, DSC on K-line (ISO 14230,
//! 10.4 kbit/s, fast init), KWP2000 with BMW-style identifiers.

use super::{EcuNode, Link, Profile};
use crate::sim::{
    ecu::{Dialect, Dtc, EcuSpec, SecuritySpec, DTC_CONFIRMED},
    VehicleState,
};

pub const ID: &str = "bmw-e90-pre2007";
pub const DME: u8 = 0x12;
pub const CAS: u8 = 0x40;
pub const DSC: u8 = 0x29;
/// KWP 0x30 IOControlByLocalIdentifier id for the electric fan test (simulated).
pub const IO_FAN: u16 = 0x0A;

pub fn dme_key(seed: &[u8]) -> Vec<u8> {
    seed.iter()
        .zip([0xC3, 0x5E].iter().cycle())
        .map(|(s, m)| s ^ m)
        .collect()
}

pub fn vehicle() -> VehicleState {
    VehicleState {
        vin: "WBAVB11060PT00001".into(),
        odometer_km: 168_200,
        ..VehicleState::default()
    }
}

/// The three ECUs and their K-line / D-CAN addresses.
pub fn ecus() -> Vec<(EcuSpec, u8)> {
    let mut dme = EcuSpec::new("DME", Dialect::Kwp2000);
    dme.obd = true;
    dme.obd_pids = vec![0x01, 0x05, 0x06, 0x07, 0x0C, 0x0D, 0x0F, 0x10, 0x31, 0x42];
    dme.ident.insert(0x80, b"7558091 MSV70 E90 N52".to_vec());
    dme.local_ids.insert(0x01, vec![0x0C, 0x80, 0x5A]);
    dme.dtcs = vec![Dtc {
        code: 0x2A82,
        ftb: 0,
        status: DTC_CONFIRMED,
    }];
    dme.security = Some(SecuritySpec {
        seed_len: 2,
        key: dme_key,
        max_attempts: 3,
        lockout_ms: 10_000,
    });
    dme.routines = vec![0x20];
    dme.io_ids = vec![IO_FAN];
    dme.p2_ms = 30;
    dme.slow_ms = 200;

    let mut cas = EcuSpec::new("CAS", Dialect::Kwp2000);
    cas.ident.insert(0x80, b"6943835 CAS3".to_vec());
    cas.p2_ms = 35;

    let mut dsc = EcuSpec::new("DSC", Dialect::Kwp2000);
    dsc.ident.insert(0x80, b"6771405 DSC8".to_vec());
    dsc.dtcs = vec![Dtc {
        code: 0x5DF6,
        ftb: 0,
        status: DTC_CONFIRMED,
    }];
    dsc.p2_ms = 28;

    vec![(dme, DME), (cas, CAS), (dsc, DSC)]
}

pub fn profile() -> Profile {
    Profile {
        id: ID,
        name: "BMW E90 (built before 03/2007, K-line)",
        link: Link::KLine { baud: 10_400 },
        ecus: ecus()
            .into_iter()
            .map(|(spec, addr)| EcuNode {
                spec,
                can: Vec::new(),
                kline: Some(addr),
            })
            .collect(),
        periodic: Vec::new(),
        vehicle: vehicle(),
        isotp_pad: 0xFF,
    }
}
