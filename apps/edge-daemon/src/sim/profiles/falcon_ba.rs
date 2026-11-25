//! Ford Falcon BA (2002–2005): PCM, IC, ABS on HS-CAN 500 kbit/s, 11-bit,
//! ISO 15765-4. OBD modes 0x01–0x0A from the PCM; Ford enhanced reads via 0x22.

use super::{CanAddr, EcuNode, Link, PeriodicFrame, Profile};
use crate::sim::{
    ecu::{Dialect, Dtc, EcuSpec, SecuritySpec, DTC_CONFIRMED, DTC_PENDING},
    VehicleState,
};

pub const ID: &str = "ford-falcon-ba";
pub const PCM: (u32, u32) = (0x7E0, 0x7E8);
pub const IC: (u32, u32) = (0x720, 0x728);
pub const ABS: (u32, u32) = (0x760, 0x768);
/// Ford enhanced PID (simulated): fuel rail pressure, kPa x 10, 2 bytes.
pub const DID_FUEL_RAIL: u16 = 0x1166;
/// Simulated service routines and I/O ids (stand-ins for the service-function UI).
pub const ROUTINE_THROTTLE_RELEARN: u16 = 0x0401;
pub const ROUTINE_CKP_RELEARN: u16 = 0x0403;
pub const ROUTINE_OIL_RESET: u16 = 0x0501;
pub const ROUTINE_SAS_CAL: u16 = 0x0602;
pub const IO_ABS_BLEED: u16 = 0x4B01;

pub fn pcm_key(seed: &[u8]) -> Vec<u8> {
    seed.iter()
        .zip([0x3B, 0xA1, 0x7C].iter().cycle())
        .map(|(s, m)| s ^ m)
        .collect()
}

fn pcm() -> EcuSpec {
    let mut spec = EcuSpec::new("PCM", Dialect::Uds);
    spec.obd = true;
    spec.obd_pids = vec![
        0x01, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x1C, 0x1F, 0x31,
        0x42,
    ];
    spec.dids.insert(DID_FUEL_RAIL, vec![0x0F, 0xA0]);
    spec.dtcs = vec![
        Dtc {
            code: 0x0171,
            ftb: 0,
            status: DTC_CONFIRMED,
        },
        Dtc {
            code: 0x0174,
            ftb: 0,
            status: DTC_PENDING,
        },
    ];
    spec.security = Some(SecuritySpec {
        seed_len: 3,
        key: pcm_key,
        max_attempts: 2,
        lockout_ms: 10_000,
    });
    spec.routines = vec![0x0301];
    // Simulated service routines (plausible stand-ins, not Ford data).
    spec.session_routines = vec![ROUTINE_THROTTLE_RELEARN, ROUTINE_CKP_RELEARN];
    spec.p2_ms = 20;
    spec
}

fn ic() -> EcuSpec {
    let mut spec = EcuSpec::new("IC", Dialect::Uds);
    spec.session_routines = vec![ROUTINE_OIL_RESET];
    spec.p2_ms = 25;
    spec
}

fn abs() -> EcuSpec {
    let mut spec = EcuSpec::new("ABS", Dialect::Uds);
    spec.dtcs = vec![Dtc {
        code: 0x5145,
        ftb: 0,
        status: DTC_CONFIRMED,
    }]; // C1145
    spec.session_routines = vec![ROUTINE_SAS_CAL];
    spec.session_io_ids = vec![IO_ABS_BLEED];
    spec.p2_ms = 18;
    spec
}

fn powertrain(v: &VehicleState, counter: u32) -> Vec<u8> {
    let [r_hi, r_lo] = ((v.rpm.clamp(0.0, 16_383.0) * 4.0) as u16).to_be_bytes();
    vec![
        r_hi,
        r_lo,
        v.speed_kmh.clamp(0.0, 255.0) as u8,
        (v.throttle_pct * 2.0).clamp(0.0, 255.0) as u8,
        0,
        0,
        0,
        (counter & 0xFF) as u8,
    ]
}

pub fn profile() -> Profile {
    let node = |spec, (req, resp): (u32, u32), obd: bool| {
        let mut can = vec![CanAddr::Normal { req, resp }];
        if obd {
            can.push(CanAddr::Functional { resp });
        }
        EcuNode {
            spec,
            can,
            kline: None,
        }
    };
    Profile {
        id: ID,
        name: "Ford Falcon BA (2002-2005)",
        link: Link::Can { bitrate: 500_000 },
        ecus: vec![
            node(pcm(), PCM, true),
            node(ic(), IC, false),
            node(abs(), ABS, false),
        ],
        periodic: vec![PeriodicFrame {
            id: 0x201,
            extended: false,
            period_ms: 20,
            payload: powertrain,
        }],
        vehicle: VehicleState {
            vin: "6FPAAAJGSW8B12345".into(),
            odometer_km: 214_500,
            ..VehicleState::default()
        },
        isotp_pad: 0x00,
    }
}
