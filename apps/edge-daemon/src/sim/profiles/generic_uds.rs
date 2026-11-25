//! Generic UDS engine ECU (2010+): ISO 15765-4, 500 kbit/s, 11-bit, full UDS set.

use super::{CanAddr, EcuNode, Link, PeriodicFrame, Profile};
use crate::sim::{
    ecu::{Dialect, Dtc, EcuSpec, SecuritySpec, DTC_CONFIRMED},
    VehicleState,
};

pub const ID: &str = "generic-uds";
pub const ENGINE_REQ: u32 = 0x7E0;
pub const ENGINE_RESP: u32 = 0x7E8;
/// IOControl DID for the idle-air actuator test.
pub const IO_IDLE_ACTUATOR: u16 = 0x0B2A;
/// RoutineControl id: check programming preconditions.
pub const ROUTINE_CHECK_PRECONDITIONS: u16 = 0x0203;
/// Calibration-data DID with a 100-byte value (multi-frame ISO-TP tests).
pub const DID_CALIBRATION: u16 = 0xF1A0;
/// Simulated service routines (stand-ins for the service-function UI).
pub const ROUTINE_THROTTLE_RELEARN: u16 = 0x0401;
pub const ROUTINE_DPF_REGEN: u16 = 0x0402;
pub const ROUTINE_CKP_RELEARN: u16 = 0x0403;
pub const ROUTINE_BMS_RESET: u16 = 0x0404;

const KEY_MASK: [u8; 4] = [0x5A, 0x3C, 0x96, 0xE1];

/// Simulation key algorithm for this ECU (tests use it to unlock).
pub fn key(seed: &[u8]) -> Vec<u8> {
    seed.iter()
        .zip(KEY_MASK.iter().cycle())
        .map(|(s, m)| s ^ m)
        .collect()
}

pub fn engine_spec() -> EcuSpec {
    let mut spec = EcuSpec::new("ENGINE", Dialect::Uds);
    spec.obd = true;
    spec.obd_pids = vec![
        0x01, 0x04, 0x05, 0x06, 0x07, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x1C, 0x1F, 0x31, 0x42, 0x46,
    ];
    spec.dids.insert(0xF187, b"GEN-ECU-0001".to_vec());
    spec.dids.insert(0xF18C, b"SN123456".to_vec());
    spec.dids.insert(DID_CALIBRATION, (0..100u8).collect());
    spec.writable_dids = vec![0xF198];
    spec.dtcs = vec![Dtc {
        code: 0x0171,
        ftb: 0x00,
        status: DTC_CONFIRMED | 0x01,
    }];
    spec.security = Some(SecuritySpec {
        seed_len: 4,
        key,
        max_attempts: 3,
        lockout_ms: 10_000,
    });
    spec.routines = vec![ROUTINE_CHECK_PRECONDITIONS];
    // Simulated service routines (stand-ins for the service-function UI).
    spec.session_routines = vec![
        ROUTINE_THROTTLE_RELEARN,
        ROUTINE_DPF_REGEN,
        ROUTINE_CKP_RELEARN,
        ROUTINE_BMS_RESET,
    ];
    spec.io_ids = vec![IO_IDLE_ACTUATOR];
    spec.p2_ms = 12;
    spec.slow_ms = 150;
    spec
}

/// 0x0C9 engine frame: RPM x4 (bytes 0-1), speed, ECT + 40, CRC-8 (byte 6,
/// SAE J1850 over the other bytes), rolling counter (byte 7 low nibble).
fn engine_data(v: &VehicleState, counter: u32) -> Vec<u8> {
    let rpm = (v.rpm.clamp(0.0, 16_383.0) * 4.0) as u16;
    let [r_hi, r_lo] = rpm.to_be_bytes();
    let mut frame = vec![
        r_hi,
        r_lo,
        v.speed_kmh.clamp(0.0, 255.0) as u8,
        (v.ect_c + 40.0).clamp(0.0, 255.0) as u8,
        0,
        0,
        0,
        (counter & 0x0F) as u8,
    ];
    let covered: Vec<u8> = frame[..6].iter().chain(&frame[7..]).copied().collect();
    frame[6] = crate::hal::stn_elm::j1850_crc(&covered);
    frame
}

fn body_data(v: &VehicleState, counter: u32) -> Vec<u8> {
    vec![
        0x00,
        u8::from(v.window_switch),
        0x00,
        (counter & 0x0F) as u8,
    ]
}

pub fn profile() -> Profile {
    Profile {
        id: ID,
        name: "Generic UDS engine ECU (2010+)",
        link: Link::Can { bitrate: 500_000 },
        ecus: vec![EcuNode {
            spec: engine_spec(),
            can: vec![
                CanAddr::Normal {
                    req: ENGINE_REQ,
                    resp: ENGINE_RESP,
                },
                CanAddr::Functional { resp: ENGINE_RESP },
            ],
            kline: None,
        }],
        periodic: vec![
            PeriodicFrame {
                id: 0x0C9,
                extended: false,
                period_ms: 10,
                payload: engine_data,
            },
            PeriodicFrame {
                id: 0x3F1,
                extended: false,
                period_ms: 100,
                payload: body_data,
            },
        ],
        vehicle: VehicleState::default(),
        isotp_pad: 0xAA,
    }
}
