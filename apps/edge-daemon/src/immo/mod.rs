//! Allow-listed immobilizer key-learn support (Phase 1, sandbox OEM only).
//!
//! The daemon never computes a SecurityAccess key. The only accepted key
//! bytes are those issued by the cloud sandbox OEM adapter in development.

use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

use crate::protocol::messages::DiagProtocol;

/// 17-character sandbox VIN (no I, O, or Q). Matches the cloud catalog.
pub const SANDBOX_VIN: &str = "SBXTESTVAN0000001";
pub const SANDBOX_OEM: &str = "SANDBOX";
pub const SANDBOX_OPERATION: &str = "add_key_onboard";
pub const SANDBOX_DEVICE_TIER: &str = "dongle";
pub const SANDBOX_DEVICE_ID: &str = "RC-DONGLE-SANDBOX";
pub const SANDBOX_PROFILE_ID: &str = "sandbox-immo";
pub const SANDBOX_ECU_TX: u32 = 0x7E2;
pub const SANDBOX_ECU_RX: u32 = 0x7EA;
/// ASCII "SBOXKEY1". Issued by the sandbox OEM adapter; not an OEM algorithm.
pub const SANDBOX_KEY: &[u8] = b"SBOXKEY1";
pub const IMMO_MIN_BATTERY_V: f64 = 13.0;
pub const IMMO_LEASE_KIND: &str = "immo_lease";
pub const MAX_IMMO_LEASE_SECS: u64 = 30 * 60;

/// The virtual adapter id is a stand-in for the sandbox dongle serial.
pub fn canonical_device_id(adapter_id: &str) -> &str {
    if adapter_id == SANDBOX_DEVICE_ID || adapter_id == "virtual-sandbox-immo" {
        SANDBOX_DEVICE_ID
    } else {
        adapter_id
    }
}

/// Fixed key used by the sandbox IMMO ECU: ignore the seed, accept the token.
pub fn sandbox_token_key(_seed: &[u8]) -> Vec<u8> {
    SANDBOX_KEY.to_vec()
}

pub fn is_sandbox_key_learn(
    protocol: DiagProtocol,
    tx: u32,
    rx: u32,
    payload: &[u8],
) -> bool {
    matches!(protocol, DiagProtocol::Uds)
        && tx == SANDBOX_ECU_TX
        && rx == SANDBOX_ECU_RX
        && payload.first() == Some(&0x27)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActiveImmo {
    pub jti: String,
    pub vin: String,
    pub device_id: String,
    pub owner: String,
}

struct RegistryState {
    active: Option<ActiveImmo>,
    aborted_jtis: HashSet<String>,
}

/// Process-wide lock: one immobilizer session at a time, no silent resume.
#[derive(Clone)]
pub struct ImmoRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

impl Default for ImmoRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl ImmoRegistry {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RegistryState {
                active: None,
                aborted_jtis: HashSet::new(),
            })),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RegistryState> {
        self.inner.lock().expect("immo registry poisoned")
    }

    pub fn is_aborted(&self, jti: &str) -> bool {
        self.lock().aborted_jtis.contains(jti)
    }

    pub fn begin(
        &self,
        jti: impl Into<String>,
        vin: impl Into<String>,
        device_id: impl Into<String>,
        owner: impl Into<String>,
    ) -> Result<ActiveImmo, String> {
        let jti = jti.into();
        let vin = vin.into();
        let device_id = device_id.into();
        let owner = owner.into();
        let mut s = self.lock();
        if s.aborted_jtis.contains(&jti) {
            return Err("immo lease was aborted; start a new session (no silent resume)".into());
        }
        if let Some(active) = &s.active {
            if active.jti == jti && active.owner == owner {
                return Ok(active.clone());
            }
            return Err("an immobilizer session is already active".into());
        }
        let active = ActiveImmo {
            jti,
            vin,
            device_id,
            owner,
        };
        s.active = Some(active.clone());
        Ok(active)
    }

    /// Abort the session owned by `owner` (or any, if `owner` is None). The jti
    /// cannot be reused.
    pub fn abort(&self, owner: Option<&str>) -> Option<String> {
        let mut s = self.lock();
        let take = match (&s.active, owner) {
            (Some(a), Some(o)) if a.owner == o => true,
            (Some(_), None) => true,
            _ => false,
        };
        if !take {
            return None;
        }
        let active = s.active.take().expect("checked");
        s.aborted_jtis.insert(active.jti.clone());
        Some(active.jti)
    }

    pub fn active(&self) -> Option<ActiveImmo> {
        self.lock().active.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_silent_resume_after_abort() {
        let reg = ImmoRegistry::new();
        reg.begin("j1", SANDBOX_VIN, SANDBOX_DEVICE_ID, "s1")
            .unwrap();
        assert_eq!(reg.abort(Some("s1")).as_deref(), Some("j1"));
        let err = reg
            .begin("j1", SANDBOX_VIN, SANDBOX_DEVICE_ID, "s1")
            .unwrap_err();
        assert!(err.contains("no silent resume"), "{err}");
        assert!(reg
            .begin("j2", SANDBOX_VIN, SANDBOX_DEVICE_ID, "s1")
            .is_ok());
    }

    #[test]
    fn concurrent_sessions_are_refused() {
        let reg = ImmoRegistry::new();
        reg.begin("j1", SANDBOX_VIN, SANDBOX_DEVICE_ID, "s1")
            .unwrap();
        let err = reg
            .begin("j2", SANDBOX_VIN, "other", "s2")
            .unwrap_err();
        assert!(err.contains("already active"), "{err}");
    }
}
