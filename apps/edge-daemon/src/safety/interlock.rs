//! `SafetyInterlock` (Task 1.2): checks every outgoing diagnostic request
//! against `safety_policy.json` before any transport sends it (A-ENG-4).
//!
//! - `SILENT` (the start state): every gated request is refused with `SAFETY_BLOCKED`.
//! - `ACTIVE_CONFIRMED`: a gated request needs a single-use safety token (60 s,
//!   bound to session, tx/rx ids, protocol, service id and the SHA-256 of the
//!   payload hex) and its tier's live preconditions.
//! - Rule 5, fail closed: a missing or stale reading (speed older than 2 s) is
//!   `PRECONDITION_UNKNOWN`, never a pass.
//! - SecurityAccess: one NRC 0x35 halts 0x27 to that ECU for the session;
//!   NRC 0x36/0x37 halt it and report the lockout delay.
//! - Every gated attempt and its result is audited (A-CEO-4).

use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};

use sha2::{Digest, Sha256};
use tokio::time::Instant;

use super::{
    audit::{AuditEntry, AuditSink, Outcome},
    policy::{self, Gating, TierRules},
    rfc3339,
};
use crate::auth::lease::ImmoLease;
use crate::immo::{self, ImmoRegistry, IMMO_MIN_BATTERY_V};
use crate::protocol::messages::{DiagProtocol, SafetyMode};

/// Lockout assumed after NRC 0x36/0x37 when the ECU does not say (ISO 14229-1
/// leaves it to the manufacturer; 10 s is the common default).
pub const DEFAULT_SECURITY_DELAY: Duration = Duration::from_secs(10);

/// Why the interlock refused a request. Maps onto the wire `ErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalCode {
    SafetyBlocked,
    TokenInvalid,
    PreconditionUnknown,
}

impl fmt::Display for RefusalCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::SafetyBlocked => "SAFETY_BLOCKED",
            Self::TokenInvalid => "TOKEN_INVALID",
            Self::PreconditionUnknown => "PRECONDITION_UNKNOWN",
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{code}: {message}")]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
    /// For a SecurityAccess lockout: how long until the ECU accepts again.
    pub retry_after: Option<Duration>,
}

impl Refusal {
    fn new(code: RefusalCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retry_after: None,
        }
    }
}

/// The request being checked: what will go on the wire, and to whom.
#[derive(Clone, Copy, Debug)]
pub struct GatedRequest<'a> {
    pub protocol: DiagProtocol,
    pub tx: u32,
    pub rx: u32,
    pub payload: &'a [u8],
}

impl GatedRequest<'_> {
    fn ecu(&self) -> String {
        format!("{} {:#05X}/{:#05X}", self.protocol, self.tx, self.rx)
    }

    fn service(&self, gating: &Gating) -> String {
        let sid = self.payload.first().copied().unwrap_or(0);
        match gating {
            Gating::Gated { name, .. } | Gating::Logged { name } => format!("{sid:#04X} {name}"),
            Gating::Ungated => format!("{sid:#04X}"),
        }
    }

    /// Binding for the token: session, ids, protocol, service and SHA-256 of the payload hex.
    fn binding(&self, session_id: &str) -> String {
        let hex: String = self.payload.iter().map(|b| format!("{b:02X}")).collect();
        let digest: String = Sha256::digest(hex.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let sid = self.payload.first().copied().unwrap_or(0);
        format!(
            "{session_id}|{}|{}|{}|{sid}|{digest}",
            self.tx, self.rx, self.protocol
        )
    }
}

/// Live readings the token was issued against (None = unknown).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Preconditions {
    pub speed_kmh: Option<f64>,
    pub speed_age: Option<Duration>,
    pub rpm: Option<f64>,
    pub battery_v: Option<f64>,
}

/// An issued safety token.
#[derive(Clone, Debug, PartialEq)]
pub struct TokenGrant {
    pub token: String,
    /// RFC 3339 UTC, for `SafetyConfirmResponse.expires_at`.
    pub expires_at: String,
    pub preconditions: Preconditions,
}

#[derive(Clone, Copy, Debug)]
struct Reading {
    value: f64,
    at: Instant,
}

struct TokenRecord {
    binding: String,
    expires: Instant,
}

#[derive(Clone, Copy, Debug)]
struct Halt {
    nrc: u8,
    /// None: halted until the session ends (NRC 0x35).
    until: Option<Instant>,
}

struct State {
    mode: SafetyMode,
    bench_mode: bool,
    user: Option<String>,
    vehicle: Option<String>,
    /// Who sent the requests when it isn't this PC's browser (a paired phone).
    client: Option<String>,
    speed: Option<Reading>,
    rpm: Option<Reading>,
    battery: Option<Reading>,
    tokens: HashMap<String, TokenRecord>,
    halts: HashMap<(String, u32, u32), Halt>,
    immo: Option<ImmoLease>,
    immo_registry: Option<ImmoRegistry>,
}

/// One interlock per diagnostic session (one WebSocket connection).
pub struct SafetyInterlock {
    session_id: String,
    audit: Arc<dyn AuditSink>,
    state: Mutex<State>,
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("OS random source available");
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("st_{hex}")
}

impl SafetyInterlock {
    /// Starts in `SILENT` with no live readings.
    pub fn new(session_id: impl Into<String>, audit: Arc<dyn AuditSink>) -> Self {
        Self {
            session_id: session_id.into(),
            audit,
            state: Mutex::new(State {
                mode: SafetyMode::Silent,
                bench_mode: false,
                user: None,
                vehicle: None,
                client: None,
                speed: None,
                rpm: None,
                battery: None,
                tokens: HashMap::new(),
                halts: HashMap::new(),
                immo: None,
                immo_registry: None,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("interlock lock poisoned")
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn mode(&self) -> SafetyMode {
        self.lock().mode
    }

    /// Switching back to SILENT also voids every outstanding token.
    pub fn set_mode(&self, mode: SafetyMode) {
        let mut s = self.lock();
        s.mode = mode;
        if mode == SafetyMode::Silent {
            s.tokens.clear();
        }
    }

    /// Who is working on which vehicle, for the audit log.
    pub fn set_identity(&self, user: Option<String>, vehicle: Option<String>) {
        let mut s = self.lock();
        s.user = user;
        s.vehicle = vehicle;
    }

    /// Names the client in every audit record of this session (a paired phone).
    pub fn set_client(&self, client: Option<String>) {
        self.lock().client = client;
    }

    /// Bench mode replaces the vehicle-speed check only. It needs its own
    /// confirmation text, is audited, and lasts until `end_session`.
    pub fn set_bench_mode(&self, on: bool, confirmation: &str) {
        self.lock().bench_mode = on;
        self.audit_raw(
            None,
            "-",
            "bench mode",
            None,
            Outcome::BenchMode,
            None,
            None,
            format!("{on}: {confirmation}"),
        );
    }

    pub fn set_immo_registry(&self, registry: ImmoRegistry) {
        self.lock().immo_registry = Some(registry);
    }

    /// Bind a verified immobilizer lease to this session. VIN and device must match.
    pub fn begin_immo(
        &self,
        lease: ImmoLease,
        vehicle_vin: &str,
        device_id: &str,
    ) -> Result<(), Refusal> {
        if vehicle_vin != lease.vin {
            return Err(Refusal::new(
                RefusalCode::SafetyBlocked,
                "immo lease VIN does not match the vehicle",
            ));
        }
        let expected_device = immo::canonical_device_id(device_id);
        if expected_device != lease.device_id {
            return Err(Refusal::new(
                RefusalCode::SafetyBlocked,
                "immo lease device does not match the connected adapter",
            ));
        }
        let registry = self.lock().immo_registry.clone();
        if let Some(registry) = registry {
            if let Err(msg) = registry.begin(
                lease.jti.clone(),
                lease.vin.clone(),
                lease.device_id.clone(),
                self.session_id.clone(),
            ) {
                return Err(Refusal::new(RefusalCode::SafetyBlocked, msg));
            }
        }
        let mut s = self.lock();
        s.vehicle = Some(lease.vin.clone());
        s.immo = Some(lease);
        drop(s);
        self.audit_raw(
            None,
            "SANDBOX_IMMO",
            "immo begin",
            None,
            Outcome::Allowed,
            None,
            None,
            "immo session bound".into(),
        );
        Ok(())
    }

    /// Hard abort. The same lease cannot be resumed.
    pub fn abort_immo(&self, reason: &str) -> bool {
        let mut s = self.lock();
        let Some(lease) = s.immo.take() else {
            return false;
        };
        let registry = s.immo_registry.clone();
        drop(s);
        if let Some(registry) = registry {
            registry.abort(Some(&self.session_id));
        }
        self.audit_raw(
            None,
            "SANDBOX_IMMO",
            "immo abort",
            None,
            Outcome::Refused,
            None,
            None,
            reason.to_owned(),
        );
        let _ = lease;
        true
    }

    pub fn immo_active(&self) -> bool {
        self.lock().immo.is_some()
    }

    fn check_immo_preconditions(s: &State, req: &GatedRequest<'_>) -> Result<(), Refusal> {
        if !immo::is_sandbox_key_learn(req.protocol, req.tx, req.rx, req.payload) {
            return Ok(());
        }
        let Some(lease) = s.immo.as_ref() else {
            return Err(Refusal::new(
                RefusalCode::SafetyBlocked,
                "allow-listed key-learn requires a valid immo lease",
            ));
        };
        if let Some(registry) = s.immo_registry.as_ref() {
            if registry.is_aborted(&lease.jti) {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    "immo lease was aborted; start a new session (no silent resume)",
                ));
            }
        }
        // Battery is checked before and during the procedure (stale or low is a fail).
        let now = Instant::now();
        match s.battery {
            None => {
                return Err(Refusal::new(
                    RefusalCode::PreconditionUnknown,
                    "battery voltage is unknown; connect a maintainer",
                ))
            }
            Some(r) if now.saturating_duration_since(r.at) > Duration::from_millis(2000) => {
                return Err(Refusal::new(
                    RefusalCode::PreconditionUnknown,
                    "battery voltage reading is stale; aborting",
                ))
            }
            Some(r) if r.value < IMMO_MIN_BATTERY_V => {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    format!(
                        "battery at {} V (needs {IMMO_MIN_BATTERY_V} V and a maintainer)",
                        r.value
                    ),
                ))
            }
            Some(_) => {}
        }
        Ok(())
    }

    pub fn update_speed(&self, kmh: f64) {
        self.lock().speed = Some(Reading {
            value: kmh,
            at: Instant::now(),
        });
    }

    pub fn update_rpm(&self, rpm: f64) {
        self.lock().rpm = Some(Reading {
            value: rpm,
            at: Instant::now(),
        });
    }

    pub fn update_battery(&self, volts: f64) {
        self.lock().battery = Some(Reading {
            value: volts,
            at: Instant::now(),
        });
    }

    /// The current readings (None = never read or not readable).
    pub fn preconditions(&self) -> Preconditions {
        let s = self.lock();
        let now = Instant::now();
        Preconditions {
            speed_kmh: s.speed.map(|r| r.value),
            speed_age: s.speed.map(|r| now - r.at),
            rpm: s.rpm.map(|r| r.value),
            battery_v: s.battery.map(|r| r.value),
        }
    }

    /// Ends the session: tokens, halts, bench mode and the live readings are
    /// cleared, mode back to SILENT. The next vehicle's speed, RPM and battery
    /// must be read afresh, never inherited from the last one.
    pub fn end_session(&self) {
        let aborted = self.abort_immo("link_drop_or_session_end");
        let mut s = self.lock();
        s.speed = None;
        s.rpm = None;
        s.battery = None;
        s.tokens.clear();
        s.halts.clear();
        s.bench_mode = false;
        s.mode = SafetyMode::Silent;
        let _ = aborted;
    }

    #[allow(clippy::too_many_arguments)]
    fn audit_raw(
        &self,
        tier: Option<char>,
        ecu: &str,
        service: &str,
        code: Option<RefusalCode>,
        outcome: Outcome,
        nrc: Option<u8>,
        state: Option<&State>,
        detail: String,
    ) {
        let (user, vehicle, client) = match state {
            Some(s) => (s.user.clone(), s.vehicle.clone(), s.client.clone()),
            None => {
                let s = self.lock();
                (s.user.clone(), s.vehicle.clone(), s.client.clone())
            }
        };
        self.audit.record(AuditEntry {
            at: rfc3339(SystemTime::now()),
            session_id: self.session_id.clone(),
            user,
            vehicle,
            client,
            ecu: ecu.to_owned(),
            service: service.to_owned(),
            tier,
            outcome,
            code: code.map(|c| c.to_string()),
            nrc,
            detail,
        });
    }

    /// Tier preconditions against live readings (Rule 5: unknown or stale fails).
    fn check_preconditions(s: &State, rules: &TierRules) -> Result<(), Refusal> {
        let now = Instant::now();
        let fresh = |r: Option<Reading>, what: &str| -> Result<f64, Refusal> {
            match r {
                None => Err(Refusal::new(
                    RefusalCode::PreconditionUnknown,
                    format!("{what} has not been read"),
                )),
                Some(r) if now - r.at > rules.max_speed_age => Err(Refusal::new(
                    RefusalCode::PreconditionUnknown,
                    format!(
                        "{what} reading is {} ms old (max {} ms)",
                        (now - r.at).as_millis(),
                        rules.max_speed_age.as_millis()
                    ),
                )),
                Some(r) => Ok(r.value),
            }
        };
        if !s.bench_mode {
            let speed = fresh(s.speed, "vehicle speed (PID 0x0D)")?;
            if speed > rules.max_speed_kmh {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    format!("vehicle moving at {speed} km/h"),
                ));
            }
        }
        if let Some(max_rpm) = rules.max_rpm {
            let rpm = fresh(s.rpm, "engine speed")?;
            if rpm > max_rpm {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    format!("engine running at {rpm} rpm"),
                ));
            }
        }
        if let Some(min_v) = rules.min_battery_v {
            let volts = fresh(s.battery, "battery voltage")?;
            if volts < min_v {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    format!("battery at {volts} V (needs {min_v} V)"),
                ));
            }
        }
        Ok(())
    }

    fn security_halt(s: &mut State, req: &GatedRequest<'_>) -> Option<Refusal> {
        let is_security = matches!(req.protocol, DiagProtocol::Uds | DiagProtocol::Kwp2000)
            && req.payload.first() == Some(&0x27);
        if !is_security {
            return None;
        }
        let key = (req.protocol.to_string(), req.tx, req.rx);
        let halt = *s.halts.get(&key)?;
        let now = Instant::now();
        match halt.until {
            Some(until) if now >= until => {
                s.halts.remove(&key);
                None
            }
            until => Some(Refusal {
                code: RefusalCode::SafetyBlocked,
                message: match until {
                    None => format!(
                        "SecurityAccess halted for this session after NRC {:#04X} (invalid key)",
                        halt.nrc
                    ),
                    Some(_) => format!(
                        "SecurityAccess halted after NRC {:#04X}: ECU time delay active",
                        halt.nrc
                    ),
                },
                retry_after: until.map(|u| u - now),
            }),
        }
    }

    /// Issues a single-use token for one gated request (`SafetyConfirmRequest`).
    pub fn issue_token(
        &self,
        req: &GatedRequest<'_>,
        user_ack_text: &str,
    ) -> Result<TokenGrant, Refusal> {
        let gating = policy::classify(req.protocol, req.payload);
        let (ecu, service) = (req.ecu(), req.service(&gating));
        let mut s = self.lock();
        let result = (|| {
            let Gating::Gated { rules, .. } = &gating else {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    "request is not gated; no token needed",
                ));
            };
            if user_ack_text.trim().is_empty() {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    "confirmation text is empty",
                ));
            }
            if s.mode != SafetyMode::ActiveConfirmed {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    "session is SILENT; reconnect in ACTIVE_CONFIRMED",
                ));
            }
            if let Some(refusal) = Self::security_halt(&mut s, req) {
                return Err(refusal);
            }
            Self::check_immo_preconditions(&s, req)?;
            Self::check_preconditions(&s, rules)?;
            let ttl = policy::token_ttl();
            let token = random_token();
            s.tokens.insert(
                token.clone(),
                TokenRecord {
                    binding: req.binding(&self.session_id),
                    expires: Instant::now() + ttl,
                },
            );
            Ok(TokenGrant {
                token,
                expires_at: rfc3339(SystemTime::now() + ttl),
                preconditions: Preconditions::default(),
            })
        })();
        let tier = match &gating {
            Gating::Gated { tier, .. } => Some(*tier),
            _ => None,
        };
        let (outcome, code, detail) = match &result {
            Ok(_) => (Outcome::TokenIssued, None, user_ack_text.to_owned()),
            Err(r) => (Outcome::TokenRefused, Some(r.code), r.message.clone()),
        };
        self.audit_raw(tier, &ecu, &service, code, outcome, None, Some(&s), detail);
        drop(s);
        result.map(|mut grant| {
            grant.preconditions = self.preconditions();
            grant
        })
    }

    /// The single check every transport calls before sending (A-ENG-4).
    pub fn check(&self, req: &GatedRequest<'_>, token: Option<&str>) -> Result<(), Refusal> {
        let gating = policy::classify(req.protocol, req.payload);
        let (ecu, service) = (req.ecu(), req.service(&gating));
        let mut s = self.lock();
        let (tier, rules) = match &gating {
            Gating::Ungated => return Ok(()),
            Gating::Logged { name } => {
                tracing::info!(%ecu, "logged ungated service: {name}");
                self.audit_raw(
                    None,
                    &ecu,
                    &service,
                    None,
                    Outcome::Logged,
                    None,
                    Some(&s),
                    String::new(),
                );
                return Ok(());
            }
            Gating::Gated { tier, rules, .. } => (*tier, *rules),
        };
        let result = (|| {
            if let Some(refusal) = Self::security_halt(&mut s, req) {
                return Err(refusal);
            }
            Self::check_immo_preconditions(&s, req)?;
            if s.mode != SafetyMode::ActiveConfirmed {
                return Err(Refusal::new(
                    RefusalCode::SafetyBlocked,
                    format!("{service} is gated; the session is SILENT"),
                ));
            }
            if rules.requires_token {
                let Some(token) = token else {
                    return Err(Refusal::new(
                        RefusalCode::TokenInvalid,
                        "gated request without a safety token",
                    ));
                };
                // Single use: the token is spent on presentation, whatever happens next.
                let Some(record) = s.tokens.remove(token) else {
                    return Err(Refusal::new(
                        RefusalCode::TokenInvalid,
                        "unknown or already used safety token",
                    ));
                };
                if Instant::now() > record.expires {
                    return Err(Refusal::new(
                        RefusalCode::TokenInvalid,
                        "safety token expired",
                    ));
                }
                if record.binding != req.binding(&self.session_id) {
                    return Err(Refusal::new(
                        RefusalCode::TokenInvalid,
                        "safety token was issued for a different request",
                    ));
                }
            }
            Self::check_preconditions(&s, &rules)
        })();
        let (outcome, code, detail) = match &result {
            Ok(()) => (Outcome::Allowed, None, String::new()),
            Err(r) => (Outcome::Refused, Some(r.code), r.message.clone()),
        };
        self.audit_raw(
            Some(tier),
            &ecu,
            &service,
            code,
            outcome,
            None,
            Some(&s),
            detail,
        );
        result
    }

    /// Feeds back the ECU's final answer to a sent request: audits gated results
    /// and halts SecurityAccess after NRC 0x35, 0x36 or 0x37.
    pub fn observe_response(&self, req: &GatedRequest<'_>, response: &[u8]) {
        let gating = policy::classify(req.protocol, req.payload);
        let Gating::Gated { tier, .. } = &gating else {
            return;
        };
        let sid = req.payload.first().copied().unwrap_or(0);
        let nrc = match response {
            [0x7F, rsid, code, ..] if *rsid == sid => Some(*code),
            _ => None,
        };
        let mut s = self.lock();
        if sid == 0x27 && matches!(req.protocol, DiagProtocol::Uds | DiagProtocol::Kwp2000) {
            let until = match nrc {
                Some(0x35) => Some(None),
                Some(0x36 | 0x37) => Some(Some(Instant::now() + DEFAULT_SECURITY_DELAY)),
                _ => None,
            };
            if let (Some(until), Some(code)) = (until, nrc) {
                s.halts.insert(
                    (req.protocol.to_string(), req.tx, req.rx),
                    Halt { nrc: code, until },
                );
                tracing::warn!(ecu = %req.ecu(), "SecurityAccess halted after NRC {code:#04X}");
            }
        }
        self.audit_raw(
            Some(*tier),
            &req.ecu(),
            &req.service(&gating),
            None,
            Outcome::Response,
            nrc,
            Some(&s),
            String::new(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{protocol, safety::audit::MemoryAudit};

    fn interlock() -> (Arc<MemoryAudit>, SafetyInterlock) {
        let audit = Arc::new(MemoryAudit::default());
        let lock = SafetyInterlock::new("sess-1", audit.clone());
        (audit, lock)
    }

    const IO: &[u8] = &[0x2F, 0x0B, 0x2A, 0x03, 0x01];

    fn req(payload: &[u8]) -> GatedRequest<'_> {
        GatedRequest {
            protocol: DiagProtocol::Uds,
            tx: 0x7E0,
            rx: 0x7E8,
            payload,
        }
    }

    fn hex_byte(s: &str) -> u8 {
        u8::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
    }

    /// The next vehicle never inherits the last one's speed, RPM or battery.
    #[test]
    fn end_session_clears_the_live_readings() {
        let (_, lock) = interlock();
        lock.update_speed(0.0);
        lock.update_rpm(0.0);
        lock.update_battery(13.0);
        lock.end_session();
        let p = lock.preconditions();
        assert_eq!((p.speed_kmh, p.rpm, p.battery_v), (None, None, None));
        assert!(p.speed_age.is_none());
    }

    /// Task 1.2 gate: every service in safety_policy.json is refused in SILENT.
    #[test]
    fn every_gated_service_refused_in_silent() {
        let (audit, lock) = interlock();
        lock.update_speed(0.0);
        lock.update_rpm(0.0);
        lock.update_battery(13.0);
        let policy = protocol::safety_policy();
        for rule in &policy.gated {
            let protocol: DiagProtocol = rule.protocol.to_string().parse().unwrap();
            let mut payload = vec![hex_byte(&rule.service_id)];
            payload.push(rule.sub_function.as_ref().map_or(0x01, |s| hex_byte(s)));
            payload.extend([0x00, 0x00]);
            let r = GatedRequest {
                protocol,
                tx: 0x7E0,
                rx: 0x7E8,
                payload: &payload,
            };
            let refusal = lock
                .check(&r, Some("st_whatever"))
                .expect_err(&format!("{} not refused", rule.name.as_str()));
            assert_eq!(
                refusal.code,
                RefusalCode::SafetyBlocked,
                "{}",
                rule.name.as_str()
            );
        }
        let refused = audit
            .entries()
            .iter()
            .filter(|e| e.outcome == Outcome::Refused)
            .count();
        assert_eq!(refused, policy.gated.len(), "every attempt audited");
    }

    #[test]
    fn ungated_passes_in_silent_and_logged_is_audited() {
        let (audit, lock) = interlock();
        assert!(lock.check(&req(&[0x22, 0xF1, 0x90]), None).is_ok());
        assert!(lock.check(&req(&[0x10, 0x03]), None).is_ok());
        assert_eq!(audit.entries().len(), 1);
        assert_eq!(audit.entries()[0].outcome, Outcome::Logged);
    }

    #[tokio::test(start_paused = true)]
    async fn token_lifecycle() {
        let (_audit, lock) = interlock();
        lock.update_speed(0.0);
        assert_eq!(
            lock.issue_token(&req(IO), "ack").unwrap_err().code,
            RefusalCode::SafetyBlocked,
            "SILENT issues no tokens"
        );
        lock.set_mode(SafetyMode::ActiveConfirmed);

        // Valid once, then reused.
        let grant = lock
            .issue_token(&req(IO), "Run idle actuator test on ENGINE")
            .unwrap();
        assert!(grant.token.starts_with("st_") && grant.expires_at.ends_with('Z'));
        assert_eq!(grant.preconditions.speed_kmh, Some(0.0));
        assert!(lock.check(&req(IO), Some(&grant.token)).is_ok());
        assert_eq!(
            lock.check(&req(IO), Some(&grant.token)).unwrap_err().code,
            RefusalCode::TokenInvalid
        );

        // Missing token.
        assert_eq!(
            lock.check(&req(IO), None).unwrap_err().code,
            RefusalCode::TokenInvalid
        );

        // Expired.
        let grant = lock.issue_token(&req(IO), "ack").unwrap();
        tokio::time::advance(Duration::from_secs(61)).await;
        lock.update_speed(0.0);
        assert_eq!(
            lock.check(&req(IO), Some(&grant.token)).unwrap_err().code,
            RefusalCode::TokenInvalid
        );

        // Mismatched: payload, tx id, service id, protocol, session.
        let mismatches: Vec<GatedRequest<'_>> = vec![
            req(&[0x2F, 0x0B, 0x2A, 0x03, 0x00]),
            GatedRequest {
                tx: 0x7E1,
                ..req(IO)
            },
            GatedRequest {
                rx: 0x7E9,
                ..req(IO)
            },
            req(&[0x31, 0x01, 0x02, 0x03]),
            GatedRequest {
                protocol: DiagProtocol::Kwp2000,
                ..req(IO)
            },
        ];
        for other in mismatches {
            let grant = lock.issue_token(&req(IO), "ack").unwrap();
            assert_eq!(
                lock.check(&other, Some(&grant.token)).unwrap_err().code,
                RefusalCode::TokenInvalid,
                "{other:?}"
            );
        }
        let other_session = SafetyInterlock::new("sess-2", Arc::new(MemoryAudit::default()));
        other_session.set_mode(SafetyMode::ActiveConfirmed);
        other_session.update_speed(0.0);
        let grant = lock.issue_token(&req(IO), "ack").unwrap();
        assert_eq!(
            other_session
                .check(&req(IO), Some(&grant.token))
                .unwrap_err()
                .code,
            RefusalCode::TokenInvalid
        );

        // Back to SILENT voids outstanding tokens.
        let grant = lock.issue_token(&req(IO), "ack").unwrap();
        lock.set_mode(SafetyMode::Silent);
        lock.set_mode(SafetyMode::ActiveConfirmed);
        assert_eq!(
            lock.check(&req(IO), Some(&grant.token)).unwrap_err().code,
            RefusalCode::TokenInvalid
        );
    }

    #[tokio::test(start_paused = true)]
    async fn speed_must_be_known_fresh_and_zero() {
        let (_audit, lock) = interlock();
        lock.set_mode(SafetyMode::ActiveConfirmed);
        // Never read.
        assert_eq!(
            lock.issue_token(&req(IO), "ack").unwrap_err().code,
            RefusalCode::PreconditionUnknown
        );
        // Read, but token used after the reading went stale (> 2 s).
        lock.update_speed(0.0);
        let grant = lock.issue_token(&req(IO), "ack").unwrap();
        tokio::time::advance(Duration::from_millis(2_100)).await;
        assert_eq!(
            lock.check(&req(IO), Some(&grant.token)).unwrap_err().code,
            RefusalCode::PreconditionUnknown
        );
        // Moving.
        lock.update_speed(4.0);
        assert_eq!(
            lock.issue_token(&req(IO), "ack").unwrap_err().code,
            RefusalCode::SafetyBlocked
        );
        // Bench mode replaces the speed check only.
        lock.set_bench_mode(true, "ECU on the bench, no vehicle");
        assert!(lock.issue_token(&req(IO), "ack").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn tier_b_needs_rpm_zero_and_battery() {
        let (_audit, lock) = interlock();
        lock.set_mode(SafetyMode::ActiveConfirmed);
        lock.update_speed(0.0);
        let programming = req(&[0x10, 0x02]);
        assert_eq!(
            lock.issue_token(&programming, "ack").unwrap_err().code,
            RefusalCode::PreconditionUnknown
        );
        lock.update_rpm(800.0);
        lock.update_battery(13.1);
        assert_eq!(
            lock.issue_token(&programming, "ack").unwrap_err().code,
            RefusalCode::SafetyBlocked
        );
        lock.update_rpm(0.0);
        lock.update_battery(12.2);
        assert_eq!(
            lock.issue_token(&programming, "ack").unwrap_err().code,
            RefusalCode::SafetyBlocked
        );
        lock.update_battery(12.6);
        assert!(lock.issue_token(&programming, "ack").is_ok());
        // Bench mode does not relax tier B's engine and battery checks.
        lock.set_bench_mode(true, "bench");
        lock.update_rpm(900.0);
        assert_eq!(
            lock.issue_token(&programming, "ack").unwrap_err().code,
            RefusalCode::SafetyBlocked
        );
    }

    #[tokio::test(start_paused = true)]
    async fn security_access_halts() {
        let (audit, lock) = interlock();
        lock.set_mode(SafetyMode::ActiveConfirmed);
        lock.update_speed(0.0);
        let key = req(&[0x27, 0x02, 0xAA, 0xBB]);
        // NRC 0x35: halted for the session; tokens cannot even be issued.
        lock.observe_response(&key, &[0x7F, 0x27, 0x35]);
        let refusal = lock.issue_token(&req(&[0x27, 0x01]), "ack").unwrap_err();
        assert_eq!(
            (refusal.code, refusal.retry_after),
            (RefusalCode::SafetyBlocked, None)
        );
        assert!(refusal.message.contains("0x35"));
        // Another ECU is unaffected.
        let other = GatedRequest {
            tx: 0x7E1,
            rx: 0x7E9,
            ..req(&[0x27, 0x01])
        };
        assert!(lock.issue_token(&other, "ack").is_ok());
        // NRC 0x37: halted with a delay, then allowed again.
        lock.observe_response(&other, &[0x7F, 0x27, 0x37]);
        let refusal = lock.issue_token(&other, "ack").unwrap_err();
        assert_eq!(refusal.retry_after, Some(DEFAULT_SECURITY_DELAY));
        tokio::time::advance(DEFAULT_SECURITY_DELAY).await;
        lock.update_speed(0.0);
        assert!(lock.issue_token(&other, "ack").is_ok());
        // end_session clears halts, and the readings: speed must be read again.
        lock.end_session();
        lock.set_mode(SafetyMode::ActiveConfirmed);
        assert_eq!(
            lock.issue_token(&req(&[0x27, 0x01]), "ack")
                .unwrap_err()
                .code,
            RefusalCode::PreconditionUnknown
        );
        lock.update_speed(0.0);
        assert!(lock.issue_token(&req(&[0x27, 0x01]), "ack").is_ok());
        assert!(audit
            .entries()
            .iter()
            .any(|e| e.outcome == Outcome::Response && e.nrc == Some(0x35)));
    }

    fn immo_req(payload: &'static [u8]) -> GatedRequest<'static> {
        GatedRequest {
            protocol: DiagProtocol::Uds,
            tx: crate::immo::SANDBOX_ECU_TX,
            rx: crate::immo::SANDBOX_ECU_RX,
            payload,
        }
    }

    fn sandbox_lease(jti: &str) -> crate::auth::lease::ImmoLease {
        crate::auth::lease::ImmoLease {
            tenant_id: "t".into(),
            user_id: "u".into(),
            session_id: "sess-1".into(),
            jti: jti.into(),
            vin: crate::immo::SANDBOX_VIN.into(),
            device_id: crate::immo::SANDBOX_DEVICE_ID.into(),
            device_tier: "dongle".into(),
            oem: "SANDBOX".into(),
            operation: "add_key_onboard".into(),
            expires_at: 0,
        }
    }

    fn ready_immo(lock: &SafetyInterlock, jti: &str) {
        let reg = crate::immo::ImmoRegistry::new();
        lock.set_immo_registry(reg);
        lock.set_mode(SafetyMode::ActiveConfirmed);
        lock.update_speed(0.0);
        lock.update_rpm(0.0);
        lock.update_battery(13.8);
        lock.begin_immo(
            sandbox_lease(jti),
            crate::immo::SANDBOX_VIN,
            crate::immo::SANDBOX_DEVICE_ID,
        )
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn immo_key_learn_requires_lease_and_voltage() {
        let (_audit, lock) = interlock();
        lock.set_mode(SafetyMode::ActiveConfirmed);
        lock.update_speed(0.0);
        let seed = immo_req(&[0x27, 0x01]);
        let err = lock.issue_token(&seed, "ack").unwrap_err();
        assert!(err.message.contains("immo lease"), "{}", err.message);

        // VIN mismatch.
        lock.update_battery(13.8);
        let bad = lock.begin_immo(
            sandbox_lease("j-vin"),
            "1HGCM82633A004352",
            crate::immo::SANDBOX_DEVICE_ID,
        );
        assert!(bad.unwrap_err().message.contains("VIN"));

        // Device mismatch.
        let bad = lock.begin_immo(
            sandbox_lease("j-dev"),
            crate::immo::SANDBOX_VIN,
            "OTHER-DONGLE",
        );
        assert!(bad.unwrap_err().message.contains("device"));

        ready_immo(&lock, "j-ok");
        // Low battery mid-session.
        lock.update_battery(12.0);
        let err = lock.issue_token(&seed, "ack").unwrap_err();
        assert!(err.message.contains("battery"), "{}", err.message);

        lock.update_battery(13.8);
        let grant = lock.issue_token(&seed, "ack").unwrap();
        assert!(lock.check(&seed, Some(&grant.token)).is_ok());

        // Stale voltage during the procedure.
        let grant = lock.issue_token(&seed, "ack").unwrap();
        tokio::time::advance(Duration::from_millis(2_100)).await;
        let err = lock.check(&seed, Some(&grant.token)).unwrap_err();
        assert_eq!(err.code, RefusalCode::PreconditionUnknown);
        assert!(
            err.message.contains("stale") || err.message.contains("battery"),
            "{}",
            err.message
        );
    }

    #[tokio::test(start_paused = true)]
    async fn immo_abort_has_no_silent_resume() {
        let registry = crate::immo::ImmoRegistry::new();
        let audit = Arc::new(MemoryAudit::default());
        let lock = SafetyInterlock::new("sess-1", audit);
        lock.set_immo_registry(registry.clone());
        lock.set_mode(SafetyMode::ActiveConfirmed);
        lock.update_speed(0.0);
        lock.update_battery(13.8);
        lock.begin_immo(
            sandbox_lease("j-abort"),
            crate::immo::SANDBOX_VIN,
            crate::immo::SANDBOX_DEVICE_ID,
        )
        .unwrap();
        assert!(lock.immo_active());
        lock.end_session(); // link drop
        assert!(!lock.immo_active());
        let lock2 = SafetyInterlock::new("sess-2", Arc::new(MemoryAudit::default()));
        lock2.set_immo_registry(registry);
        lock2.set_mode(SafetyMode::ActiveConfirmed);
        lock2.update_speed(0.0);
        lock2.update_battery(13.8);
        let err = lock2
            .begin_immo(
                sandbox_lease("j-abort"),
                crate::immo::SANDBOX_VIN,
                crate::immo::SANDBOX_DEVICE_ID,
            )
            .unwrap_err();
        assert!(err.message.contains("no silent resume"), "{}", err.message);
    }
}
