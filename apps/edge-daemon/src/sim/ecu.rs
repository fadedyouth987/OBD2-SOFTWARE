//! Application-layer ECU simulator: request bytes in, timed response bytes out.
//!
//! One engine serves every virtual profile. It models what upper layers must
//! cope with on real cars: response timing (P2), NRC 0x78 responsePending before
//! slow services, session and security preconditions, and SecurityAccess
//! seed/key with an attempt limit and time-delay lockout (NRC 0x35/0x36/0x37).
//!
//! The simulator does not enforce the safety policy; that is the tester's job
//! (`SafetyInterlock`, Task 1.2). It answers like a real ECU would.

use std::collections::BTreeMap;

use super::VehicleState;

/// Positive-response offset for every service.
pub const POSITIVE: u8 = 0x40;
pub const NEGATIVE: u8 = 0x7F;

/// Negative response codes used by the simulator (ISO 14229-1 / ISO 14230-3).
pub mod nrc {
    pub const SERVICE_NOT_SUPPORTED: u8 = 0x11;
    pub const SUB_FUNCTION_NOT_SUPPORTED: u8 = 0x12;
    pub const INCORRECT_LENGTH: u8 = 0x13;
    pub const CONDITIONS_NOT_CORRECT: u8 = 0x22;
    pub const REQUEST_SEQUENCE_ERROR: u8 = 0x24;
    pub const REQUEST_OUT_OF_RANGE: u8 = 0x31;
    pub const SECURITY_ACCESS_DENIED: u8 = 0x33;
    pub const INVALID_KEY: u8 = 0x35;
    pub const EXCEEDED_ATTEMPTS: u8 = 0x36;
    pub const TIME_DELAY_NOT_EXPIRED: u8 = 0x37;
    pub const RESPONSE_PENDING: u8 = 0x78;
    pub const NOT_SUPPORTED_IN_SESSION: u8 = 0x7F;
}

/// Which diagnostic application protocol the ECU speaks (besides OBD modes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    /// ISO 14229-1.
    Uds,
    /// ISO 14230-3 with BMW-style identifiers.
    Kwp2000,
}

/// Diagnostic session, normalized across dialects.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Session {
    Default,
    Programming,
    Extended,
}

/// A stored trouble code. `code` is the SAE J2012 two-byte form (P0171 = 0x0171,
/// C1145 = 0x5145); UDS adds `ftb` (failure type byte) as the third byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dtc {
    pub code: u16,
    pub ftb: u8,
    /// UDS status byte: bit0 testFailed, bit2 pending, bit3 confirmed, bit7 MIL.
    pub status: u8,
}

pub const DTC_PENDING: u8 = 0x04;
pub const DTC_CONFIRMED: u8 = 0x08;

/// SecurityAccess behaviour.
#[derive(Clone, Copy, Debug)]
pub struct SecuritySpec {
    pub seed_len: usize,
    /// The ECU's key algorithm (simulation only; real algorithms are not shipped).
    pub key: fn(&[u8]) -> Vec<u8>,
    /// Wrong keys allowed before NRC 0x36 and the lockout.
    pub max_attempts: u8,
    /// Lockout after the last failed attempt (NRC 0x37 until it expires).
    pub lockout_ms: u64,
}

/// Static description of one ECU.
#[derive(Clone, Debug)]
pub struct EcuSpec {
    pub name: &'static str,
    pub dialect: Dialect,
    /// Answers SAE J1979 OBD modes 0x01–0x0A.
    pub obd: bool,
    /// Data identifiers for 0x22 (UDS DID / KWP common identifier).
    pub dids: BTreeMap<u16, Vec<u8>>,
    /// DIDs writable with 0x2E once unlocked.
    pub writable_dids: Vec<u16>,
    /// KWP 0x21 ReadDataByLocalIdentifier.
    pub local_ids: BTreeMap<u8, Vec<u8>>,
    /// KWP 0x1A ReadECUIdentification.
    pub ident: BTreeMap<u8, Vec<u8>>,
    pub dtcs: Vec<Dtc>,
    pub security: Option<SecuritySpec>,
    /// Routine identifiers (UDS 0x31 two-byte; KWP 0x31 one-byte).
    pub routines: Vec<u16>,
    /// UDS service routines (maintenance resets, relearns) that run in the
    /// extended session without SecurityAccess, as on many real modules.
    pub session_routines: Vec<u16>,
    /// I/O control identifiers (UDS 0x2F DIDs; KWP 0x30 local ids).
    pub io_ids: Vec<u16>,
    /// I/O controls (UDS 0x2F) that run in the extended session without
    /// SecurityAccess, like `session_routines` (simulated service functions).
    pub session_io_ids: Vec<u16>,
    /// Normal response time.
    pub p2_ms: u64,
    /// Time a slow service takes after its 0x78 responsePending.
    pub slow_ms: u64,
    /// KWP StartCommunication key bytes.
    pub key_bytes: (u8, u8),
    /// OBD mode 0x01 PIDs this ECU answers.
    pub obd_pids: Vec<u8>,
}

impl EcuSpec {
    pub fn new(name: &'static str, dialect: Dialect) -> Self {
        Self {
            name,
            dialect,
            obd: false,
            dids: BTreeMap::new(),
            writable_dids: Vec::new(),
            local_ids: BTreeMap::new(),
            ident: BTreeMap::new(),
            dtcs: Vec::new(),
            security: None,
            routines: Vec::new(),
            session_routines: Vec::new(),
            io_ids: Vec::new(),
            session_io_ids: Vec::new(),
            p2_ms: 15,
            slow_ms: 120,
            key_bytes: (0xEF, 0x8F),
            obd_pids: Vec::new(),
        }
    }
}

/// One response, `delay_ms` after the request (or after the previous reply's
/// request, for a 0x78 sequence: delays are measured from the request).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub delay_ms: u64,
    pub data: Vec<u8>,
}

/// A running ECU.
#[derive(Debug)]
pub struct EcuSim {
    pub spec: EcuSpec,
    session: Session,
    unlocked: bool,
    pending_seed: Option<Vec<u8>>,
    failed_attempts: u8,
    locked_until_ms: u64,
    seed_counter: u32,
}

fn negative(sid: u8, code: u8) -> Vec<u8> {
    vec![NEGATIVE, sid, code]
}

fn positive(sid: u8, rest: &[u8]) -> Vec<u8> {
    let mut out = vec![sid + POSITIVE];
    out.extend_from_slice(rest);
    out
}

impl EcuSim {
    pub fn new(spec: EcuSpec) -> Self {
        Self {
            spec,
            session: Session::Default,
            unlocked: false,
            pending_seed: None,
            failed_attempts: 0,
            locked_until_ms: 0,
            seed_counter: 0x1234_5678,
        }
    }

    pub fn name(&self) -> &'static str {
        self.spec.name
    }

    pub fn session(&self) -> Session {
        self.session
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked
    }

    /// Replaces a DID value (tests use this to stage tampering, e.g. an odometer mismatch).
    pub fn set_did(&mut self, did: u16, value: Vec<u8>) {
        self.spec.dids.insert(did, value);
    }

    /// Ends the diagnostic session, as on a P3/S3 timeout or StopCommunication.
    pub fn reset_session(&mut self) {
        self.session = Session::Default;
        self.unlocked = false;
        self.pending_seed = None;
    }

    fn now_reply(&self, data: Vec<u8>) -> Vec<Reply> {
        vec![Reply {
            delay_ms: self.spec.p2_ms,
            data,
        }]
    }

    /// A slow service: NRC 0x78 at P2, then the final answer.
    fn slow_reply(&self, sid: u8, data: Vec<u8>) -> Vec<Reply> {
        vec![
            Reply {
                delay_ms: self.spec.p2_ms,
                data: negative(sid, nrc::RESPONSE_PENDING),
            },
            Reply {
                delay_ms: self.spec.p2_ms + self.spec.slow_ms,
                data,
            },
        ]
    }

    /// Handles one complete request at simulation time `now_ms`.
    pub fn handle(&mut self, now_ms: u64, req: &[u8], vehicle: &mut VehicleState) -> Vec<Reply> {
        let Some(&sid) = req.first() else {
            return Vec::new();
        };
        if self.spec.obd && (0x01..=0x0A).contains(&sid) {
            return self.obd(req, vehicle);
        }
        match self.spec.dialect {
            Dialect::Uds => self.uds(now_ms, req, vehicle),
            Dialect::Kwp2000 => self.kwp(now_ms, req, vehicle),
        }
    }

    fn require_session(&self, sid: u8) -> Option<Vec<Reply>> {
        (self.session == Session::Default)
            .then(|| self.now_reply(negative(sid, nrc::NOT_SUPPORTED_IN_SESSION)))
    }

    fn require_unlocked(&self, sid: u8) -> Option<Vec<Reply>> {
        (self.spec.security.is_some() && !self.unlocked)
            .then(|| self.now_reply(negative(sid, nrc::SECURITY_ACCESS_DENIED)))
    }

    fn next_seed(&mut self, len: usize) -> Vec<u8> {
        // Deterministic LCG so tests are reproducible; never all-zero.
        let mut seed = Vec::with_capacity(len);
        for _ in 0..len {
            self.seed_counter = self
                .seed_counter
                .wrapping_mul(1_103_515_245)
                .wrapping_add(12_345);
            seed.push((self.seed_counter >> 16) as u8 | 0x01);
        }
        seed
    }

    /// SecurityAccess (0x27) for both dialects.
    fn security_access(&mut self, now_ms: u64, req: &[u8]) -> Vec<Reply> {
        let sid = req[0];
        let Some(spec) = self.spec.security else {
            return self.now_reply(negative(sid, nrc::SERVICE_NOT_SUPPORTED));
        };
        if let Some(r) = self.require_session(sid) {
            return r;
        }
        let Some(&level) = req.get(1) else {
            return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
        };
        if level % 2 == 1 {
            // requestSeed
            if now_ms < self.locked_until_ms {
                return self.now_reply(negative(sid, nrc::TIME_DELAY_NOT_EXPIRED));
            }
            let seed = if self.unlocked {
                vec![0; spec.seed_len]
            } else {
                self.next_seed(spec.seed_len)
            };
            self.pending_seed = (!self.unlocked).then(|| seed.clone());
            let mut rest = vec![level];
            rest.extend_from_slice(&seed);
            return self.now_reply(positive(sid, &rest));
        }
        // sendKey
        let Some(seed) = self.pending_seed.take() else {
            return self.now_reply(negative(sid, nrc::REQUEST_SEQUENCE_ERROR));
        };
        if req[2..] == (spec.key)(&seed)[..] {
            self.unlocked = true;
            self.failed_attempts = 0;
            let rest: &[u8] = match self.spec.dialect {
                Dialect::Uds => &[level],
                Dialect::Kwp2000 => &[level, 0x34], // securityAccessAllowed
            };
            return self.now_reply(positive(sid, rest));
        }
        self.failed_attempts += 1;
        if self.failed_attempts >= spec.max_attempts {
            self.failed_attempts = 0;
            self.locked_until_ms = now_ms + spec.lockout_ms;
            return self.now_reply(negative(sid, nrc::EXCEEDED_ATTEMPTS));
        }
        self.now_reply(negative(sid, nrc::INVALID_KEY))
    }

    fn read_dids(&self, req: &[u8], vehicle: &VehicleState) -> Vec<Reply> {
        let sid = req[0];
        let ids = &req[1..];
        if ids.is_empty() || !ids.len().is_multiple_of(2) {
            return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
        }
        let mut rest = Vec::new();
        for pair in ids.chunks(2) {
            let did = u16::from_be_bytes([pair[0], pair[1]]);
            let Some(value) = self.did_value(did, vehicle) else {
                return self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE));
            };
            rest.extend_from_slice(pair);
            rest.extend_from_slice(&value);
        }
        self.now_reply(positive(sid, &rest))
    }

    /// Static DIDs, with VIN and odometer falling back to the shared vehicle state.
    fn did_value(&self, did: u16, vehicle: &VehicleState) -> Option<Vec<u8>> {
        if let Some(v) = self.spec.dids.get(&did) {
            return Some(v.clone());
        }
        match did {
            super::DID_VIN => Some(vehicle.vin.as_bytes().to_vec()),
            super::DID_ODOMETER => Some(vehicle.odometer_km.to_be_bytes()[1..].to_vec()),
            _ => None,
        }
    }

    fn clear_dtcs(&mut self, vehicle: &mut VehicleState) {
        self.spec.dtcs.clear();
        vehicle.distance_since_clear_km = 0;
        vehicle.monitors_complete = false;
    }

    fn session_control(&mut self, req: &[u8]) -> Vec<Reply> {
        let sid = req[0];
        let Some(&raw) = req.get(1) else {
            return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
        };
        let sub = raw & 0x7F;
        let target = match (self.spec.dialect, sub) {
            (Dialect::Uds, 0x01) | (Dialect::Kwp2000, 0x81) => Session::Default,
            (Dialect::Uds, 0x02) | (Dialect::Kwp2000, 0x85) => Session::Programming,
            (Dialect::Uds, 0x03) | (Dialect::Kwp2000, 0x86 | 0x87 | 0x89) => Session::Extended,
            _ => return self.now_reply(negative(sid, nrc::SUB_FUNCTION_NOT_SUPPORTED)),
        };
        if target == Session::Programming && self.session != Session::Extended {
            return self.now_reply(negative(sid, nrc::CONDITIONS_NOT_CORRECT));
        }
        if target != self.session {
            self.unlocked = false;
            self.pending_seed = None;
        }
        self.session = target;
        if self.spec.dialect == Dialect::Uds && raw & 0x80 != 0 {
            return Vec::new(); // suppressPosRspMsgIndicationBit
        }
        let rest: Vec<u8> = match self.spec.dialect {
            // P2 = 50 ms, P2* = 5,000 ms (in 10 ms units).
            Dialect::Uds => vec![sub, 0x00, 0x32, 0x01, 0xF4],
            Dialect::Kwp2000 => vec![sub],
        };
        self.now_reply(positive(sid, &rest))
    }

    /// Services with a sub-function byte that may carry the suppress bit.
    fn simple_sub(&mut self, req: &[u8]) -> Vec<Reply> {
        let sid = req[0];
        let Some(&raw) = req.get(1) else {
            return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
        };
        if sid == 0x11 {
            self.reset_session();
        }
        if self.spec.dialect == Dialect::Uds && raw & 0x80 != 0 {
            return Vec::new();
        }
        self.now_reply(positive(sid, &[raw & 0x7F]))
    }

    fn uds(&mut self, now_ms: u64, req: &[u8], vehicle: &mut VehicleState) -> Vec<Reply> {
        let sid = req[0];
        match sid {
            0x10 => self.session_control(req),
            0x11 | 0x28 | 0x85 => {
                if sid != 0x11 {
                    if let Some(r) = self.require_session(sid) {
                        return r;
                    }
                }
                self.simple_sub(req)
            }
            0x3E => match req.get(1) {
                Some(sub) if sub & 0x80 != 0 => Vec::new(),
                Some(_) => self.now_reply(positive(sid, &[0x00])),
                None => self.now_reply(negative(sid, nrc::INCORRECT_LENGTH)),
            },
            0x22 => self.read_dids(req, vehicle),
            0x19 => self.read_dtc_information(req),
            0x14 => {
                if req.len() != 4 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                self.clear_dtcs(vehicle);
                self.slow_reply(sid, positive(sid, &[]))
            }
            0x27 => self.security_access(now_ms, req),
            0x2E => {
                if req.len() < 4 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                if let Some(r) = self
                    .require_session(sid)
                    .or_else(|| self.require_unlocked(sid))
                {
                    return r;
                }
                let did = u16::from_be_bytes([req[1], req[2]]);
                if !self.spec.writable_dids.contains(&did) {
                    return self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE));
                }
                self.spec.dids.insert(did, req[3..].to_vec());
                self.now_reply(positive(sid, &req[1..3]))
            }
            0x2F => {
                if req.len() < 4 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                let did = u16::from_be_bytes([req[1], req[2]]);
                if self.spec.session_io_ids.contains(&did) {
                    if let Some(r) = self.require_session(sid) {
                        return r;
                    }
                    return self.now_reply(positive(sid, &req[1..]));
                }
                if let Some(r) = self
                    .require_session(sid)
                    .or_else(|| self.require_unlocked(sid))
                {
                    return r;
                }
                if !self.spec.io_ids.contains(&did) {
                    return self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE));
                }
                self.now_reply(positive(sid, &req[1..]))
            }
            0x31 => {
                if req.len() < 4 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                let rid = u16::from_be_bytes([req[2], req[3]]);
                if self.spec.session_routines.contains(&rid) {
                    if let Some(r) = self.require_session(sid) {
                        return r;
                    }
                    let sub = req[1] & 0x7F;
                    return match sub {
                        0x01 | 0x02 => {
                            self.slow_reply(sid, positive(sid, &[sub, req[2], req[3], 0x00]))
                        }
                        // Results: 0x00 = completed successfully.
                        0x03 => self.now_reply(positive(sid, &[sub, req[2], req[3], 0x00])),
                        _ => self.now_reply(negative(sid, nrc::SUB_FUNCTION_NOT_SUPPORTED)),
                    };
                }
                if let Some(r) = self
                    .require_session(sid)
                    .or_else(|| self.require_unlocked(sid))
                {
                    return r;
                }
                let sub = req[1] & 0x7F;
                let rid = u16::from_be_bytes([req[2], req[3]]);
                if !(1..=3).contains(&sub) {
                    return self.now_reply(negative(sid, nrc::SUB_FUNCTION_NOT_SUPPORTED));
                }
                if !self.spec.routines.contains(&rid) {
                    return self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE));
                }
                self.slow_reply(sid, positive(sid, &[sub, req[2], req[3], 0x00]))
            }
            // Programming and authentication services: the simulator never flashes.
            0x29 | 0x34 | 0x35 | 0x36 | 0x37 | 0x38 | 0x3D | 0x87 => {
                let code = if self.session == Session::Programming && self.unlocked {
                    nrc::CONDITIONS_NOT_CORRECT
                } else if self.session == Session::Programming {
                    nrc::SECURITY_ACCESS_DENIED
                } else {
                    nrc::NOT_SUPPORTED_IN_SESSION
                };
                self.now_reply(negative(sid, code))
            }
            _ => self.now_reply(negative(sid, nrc::SERVICE_NOT_SUPPORTED)),
        }
    }

    fn read_dtc_information(&self, req: &[u8]) -> Vec<Reply> {
        let sid = req[0];
        let Some(&sub) = req.get(1) else {
            return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
        };
        let mask = req.get(2).copied().unwrap_or(0xFF);
        let matching = || self.spec.dtcs.iter().filter(move |d| d.status & mask != 0);
        match sub {
            0x01 => {
                let count = matching().count() as u16;
                let [hi, lo] = count.to_be_bytes();
                // availability mask, format ISO 14229-1 (0x01), count
                self.now_reply(positive(sid, &[0x01, 0xFF, 0x01, hi, lo]))
            }
            0x02 | 0x0A => {
                let mut rest = vec![sub, 0xFF];
                let list: Vec<&Dtc> = if sub == 0x0A {
                    self.spec.dtcs.iter().collect()
                } else {
                    matching().collect()
                };
                for d in list {
                    let [hi, lo] = d.code.to_be_bytes();
                    rest.extend_from_slice(&[hi, lo, d.ftb, d.status]);
                }
                self.now_reply(positive(sid, &rest))
            }
            _ => self.now_reply(negative(sid, nrc::SUB_FUNCTION_NOT_SUPPORTED)),
        }
    }

    fn kwp(&mut self, now_ms: u64, req: &[u8], vehicle: &mut VehicleState) -> Vec<Reply> {
        let sid = req[0];
        match sid {
            0x81 => {
                let (kb1, kb2) = self.spec.key_bytes;
                self.now_reply(positive(sid, &[kb1, kb2]))
            }
            0x82 => {
                self.reset_session();
                self.now_reply(positive(sid, &[]))
            }
            0x10 => self.session_control(req),
            0x11 => self.simple_sub(req),
            0x3E => self.now_reply(positive(sid, &[])),
            0x1A => match req
                .get(1)
                .and_then(|id| self.spec.ident.get(id).map(|v| (id, v)))
            {
                Some((id, value)) => {
                    let mut rest = vec![*id];
                    rest.extend_from_slice(value);
                    self.now_reply(positive(sid, &rest))
                }
                None => self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE)),
            },
            0x21 => match req
                .get(1)
                .and_then(|id| self.spec.local_ids.get(id).map(|v| (id, v)))
            {
                Some((id, value)) => {
                    let mut rest = vec![*id];
                    rest.extend_from_slice(value);
                    self.now_reply(positive(sid, &rest))
                }
                None => self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE)),
            },
            0x22 => self.read_dids(req, vehicle),
            0x18 => {
                // ReadDiagnosticTroubleCodesByStatus: status, group (2)
                let mut rest = vec![self.spec.dtcs.len() as u8];
                for d in &self.spec.dtcs {
                    let [hi, lo] = d.code.to_be_bytes();
                    rest.extend_from_slice(&[hi, lo, d.status]);
                }
                self.now_reply(positive(sid, &rest))
            }
            0x14 => {
                if req.len() != 3 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                self.clear_dtcs(vehicle);
                self.slow_reply(sid, positive(sid, &req[1..3]))
            }
            0x27 => self.security_access(now_ms, req),
            0x30 | 0x2F => {
                if req.len() < 3 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                if let Some(r) = self
                    .require_session(sid)
                    .or_else(|| self.require_unlocked(sid))
                {
                    return r;
                }
                let id = if sid == 0x30 {
                    u16::from(req[1])
                } else {
                    u16::from_be_bytes([req[1], req[2]])
                };
                if !self.spec.io_ids.contains(&id) {
                    return self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE));
                }
                self.now_reply(positive(sid, &req[1..]))
            }
            0x31 => {
                if req.len() < 2 {
                    return self.now_reply(negative(sid, nrc::INCORRECT_LENGTH));
                }
                if let Some(r) = self
                    .require_session(sid)
                    .or_else(|| self.require_unlocked(sid))
                {
                    return r;
                }
                if !self.spec.routines.contains(&u16::from(req[1])) {
                    return self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE));
                }
                self.slow_reply(sid, positive(sid, &[req[1]]))
            }
            0x3B | 0x2E => {
                if let Some(r) = self
                    .require_session(sid)
                    .or_else(|| self.require_unlocked(sid))
                {
                    return r;
                }
                self.now_reply(negative(sid, nrc::REQUEST_OUT_OF_RANGE))
            }
            0x28 | 0x85 => {
                if let Some(r) = self.require_session(sid) {
                    return r;
                }
                self.now_reply(positive(sid, &req[1..req.len().min(2)]))
            }
            0x34..=0x38 | 0x3D => self.now_reply(negative(
                sid,
                if self.session == Session::Programming {
                    nrc::CONDITIONS_NOT_CORRECT
                } else {
                    nrc::NOT_SUPPORTED_IN_SESSION
                },
            )),
            _ => self.now_reply(negative(sid, nrc::SERVICE_NOT_SUPPORTED)),
        }
    }

    /// SAE J1979 modes 0x01–0x0A.
    fn obd(&mut self, req: &[u8], vehicle: &mut VehicleState) -> Vec<Reply> {
        let mode = req[0];
        match mode {
            0x01 => {
                if req.len() < 2 || req.len() > 7 {
                    return self.now_reply(negative(mode, nrc::INCORRECT_LENGTH));
                }
                let mut rest = Vec::new();
                for &pid in &req[1..] {
                    if let Some(bytes) = self.pid_value(pid, vehicle) {
                        rest.push(pid);
                        rest.extend_from_slice(&bytes);
                    }
                }
                if rest.is_empty() {
                    return self.now_reply(negative(mode, nrc::SUB_FUNCTION_NOT_SUPPORTED));
                }
                self.now_reply(positive(mode, &rest))
            }
            0x03 | 0x07 => {
                let want = if mode == 0x03 {
                    DTC_CONFIRMED
                } else {
                    DTC_PENDING
                };
                let codes: Vec<u16> = self
                    .spec
                    .dtcs
                    .iter()
                    .filter(|d| d.status & want != 0)
                    .map(|d| d.code)
                    .collect();
                let mut rest = vec![codes.len() as u8];
                for code in codes {
                    rest.extend_from_slice(&code.to_be_bytes());
                }
                self.now_reply(positive(mode, &rest))
            }
            0x0A => self.now_reply(positive(mode, &[0x00])),
            0x04 => {
                self.clear_dtcs(vehicle);
                self.now_reply(positive(mode, &[]))
            }
            0x09 => match req.get(1) {
                Some(0x00) => self.now_reply(positive(mode, &[0x00, 0x54, 0x40, 0x00, 0x00])),
                Some(0x02) => {
                    let mut rest = vec![0x02, 0x01];
                    rest.extend_from_slice(vehicle.vin.as_bytes());
                    self.now_reply(positive(mode, &rest))
                }
                Some(0x0A) => {
                    let mut name = format!("ECM\0-{}", self.spec.name).into_bytes();
                    name.resize(20, 0);
                    let mut rest = vec![0x0A, 0x01];
                    rest.extend_from_slice(&name);
                    self.now_reply(positive(mode, &rest))
                }
                _ => self.now_reply(negative(mode, nrc::SUB_FUNCTION_NOT_SUPPORTED)),
            },
            _ => self.now_reply(negative(mode, nrc::SUB_FUNCTION_NOT_SUPPORTED)),
        }
    }

    /// Mode 0x01 PID encodings (SAE J1979), from the shared vehicle state.
    fn pid_value(&self, pid: u8, v: &VehicleState) -> Option<Vec<u8>> {
        if matches!(pid, 0x00 | 0x20 | 0x40 | 0x60) {
            // Supported-PID bitmap for pid+1 ..= pid+0x20.
            let mut bits = 0u32;
            for &p in &self.spec.obd_pids {
                if p > pid && p <= pid + 0x20 {
                    bits |= 1 << (0x20 - (p - pid));
                }
            }
            if self.spec.obd_pids.iter().any(|&p| p > pid + 0x20) {
                bits |= 1; // next range supported
            }
            return (pid == 0x00 || bits != 0).then(|| bits.to_be_bytes().to_vec());
        }
        if !self.spec.obd_pids.contains(&pid) {
            return None;
        }
        let byte = |x: f64| x.round().clamp(0.0, 255.0) as u8;
        let word = |x: f64| {
            (x.round().clamp(0.0, 65_535.0) as u16)
                .to_be_bytes()
                .to_vec()
        };
        let trim = |pct: f64| byte(pct * 128.0 / 100.0 + 128.0);
        Some(match pid {
            0x01 => {
                let confirmed = self
                    .spec
                    .dtcs
                    .iter()
                    .filter(|d| d.status & DTC_CONFIRMED != 0)
                    .count();
                let mil = if confirmed > 0 { 0x80 } else { 0x00 };
                let incomplete = if v.monitors_complete { 0x00 } else { 0x65 };
                vec![mil | confirmed.min(0x7F) as u8, 0x07, 0x65, incomplete]
            }
            0x04 => vec![byte(v.load_pct * 255.0 / 100.0)],
            0x05 => vec![byte(v.ect_c + 40.0)],
            0x06 => vec![trim(v.stft_pct[0])],
            0x07 => vec![trim(v.ltft_pct[0])],
            0x08 => vec![trim(v.stft_pct[1])],
            0x09 => vec![trim(v.ltft_pct[1])],
            0x0C => word(v.rpm * 4.0),
            0x0D => vec![byte(v.speed_kmh)],
            0x0F => vec![byte(v.iat_c + 40.0)],
            0x10 => word(v.maf_gs * 100.0),
            0x11 => vec![byte(v.throttle_pct * 255.0 / 100.0)],
            0x1C => vec![0x01],
            0x1F => word(f64::from(v.runtime_s)),
            0x31 => word(f64::from(v.distance_since_clear_km)),
            0x42 => word(v.battery_v * 1000.0),
            0x46 => vec![byte(v.ambient_c + 40.0)],
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uds_ecu() -> EcuSim {
        let mut spec = EcuSpec::new("TEST", Dialect::Uds);
        spec.security = Some(SecuritySpec {
            seed_len: 2,
            key: |seed| seed.iter().map(|b| b ^ 0xFF).collect(),
            max_attempts: 2,
            lockout_ms: 10_000,
        });
        spec.io_ids = vec![0x0B2A];
        spec.routines = vec![0x0203];
        EcuSim::new(spec)
    }

    fn one(replies: Vec<Reply>) -> Vec<u8> {
        assert_eq!(replies.len(), 1, "{replies:?}");
        replies.into_iter().next().unwrap().data
    }

    #[test]
    fn security_access_unlock_and_lockout() {
        let mut v = VehicleState::default();
        let mut ecu = uds_ecu();
        // Not in the default session.
        assert_eq!(
            one(ecu.handle(0, &[0x27, 0x01], &mut v)),
            vec![0x7F, 0x27, 0x7F]
        );
        one(ecu.handle(0, &[0x10, 0x03], &mut v));
        // Key without seed.
        assert_eq!(
            one(ecu.handle(0, &[0x27, 0x02, 0, 0], &mut v)),
            vec![0x7F, 0x27, 0x24]
        );
        // Wrong key: 0x35, then 0x36 and lockout.
        one(ecu.handle(0, &[0x27, 0x01], &mut v));
        assert_eq!(
            one(ecu.handle(0, &[0x27, 0x02, 0, 0], &mut v)),
            vec![0x7F, 0x27, 0x35]
        );
        one(ecu.handle(0, &[0x27, 0x01], &mut v));
        assert_eq!(
            one(ecu.handle(0, &[0x27, 0x02, 0, 0], &mut v)),
            vec![0x7F, 0x27, 0x36]
        );
        assert_eq!(
            one(ecu.handle(5_000, &[0x27, 0x01], &mut v)),
            vec![0x7F, 0x27, 0x37]
        );
        // After the delay, the right key unlocks.
        let seed = one(ecu.handle(10_000, &[0x27, 0x01], &mut v));
        let key: Vec<u8> = seed[2..].iter().map(|b| b ^ 0xFF).collect();
        let mut req = vec![0x27, 0x02];
        req.extend(key);
        assert_eq!(one(ecu.handle(10_000, &req, &mut v)), vec![0x67, 0x02]);
        assert!(ecu.is_unlocked());
    }

    #[test]
    fn io_control_needs_session_and_unlock() {
        let mut v = VehicleState::default();
        let mut ecu = uds_ecu();
        let req = [0x2F, 0x0B, 0x2A, 0x03, 0x01];
        assert_eq!(one(ecu.handle(0, &req, &mut v)), vec![0x7F, 0x2F, 0x7F]);
        one(ecu.handle(0, &[0x10, 0x03], &mut v));
        assert_eq!(one(ecu.handle(0, &req, &mut v)), vec![0x7F, 0x2F, 0x33]);
    }

    #[test]
    fn slow_services_send_response_pending_first() {
        let mut v = VehicleState::default();
        let mut ecu = uds_ecu();
        let replies = ecu.handle(0, &[0x14, 0xFF, 0xFF, 0xFF], &mut v);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0].data, vec![0x7F, 0x14, 0x78]);
        assert_eq!(replies[1].data, vec![0x54]);
        assert!(replies[1].delay_ms > replies[0].delay_ms);
    }

    #[test]
    fn obd_pids_encode_vehicle_state() {
        let mut v = VehicleState {
            rpm: 812.5,
            speed_kmh: 0.0,
            ..VehicleState::default()
        };
        let mut spec = EcuSpec::new("OBD", Dialect::Uds);
        spec.obd = true;
        spec.obd_pids = vec![0x0C, 0x0D, 0x42];
        let mut ecu = EcuSim::new(spec);
        assert_eq!(
            one(ecu.handle(0, &[0x01, 0x0C, 0x0D], &mut v)),
            vec![0x41, 0x0C, 0x0C, 0xB2, 0x0D, 0x00]
        );
        // Bitmap: 0x0C, 0x0D, and "next range" because 0x42 > 0x20.
        assert_eq!(
            one(ecu.handle(0, &[0x01, 0x00], &mut v)),
            vec![0x41, 0x00, 0x00, 0x18, 0x00, 0x01]
        );
        assert_eq!(
            one(ecu.handle(0, &[0x01, 0x99], &mut v)),
            vec![0x7F, 0x01, 0x12]
        );
    }
}
