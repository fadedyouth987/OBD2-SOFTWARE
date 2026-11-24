//! Offline capability leases and cloud pairing tokens (Task 1.4).
//!
//! Lease (`aud=edge-daemon`, issued by `POST /api/v1/auth/edge-lease`, Task 2.2):
//! `tenant_id`, `tier`, `features`, `aasra_verified`, `nbf`, `exp`; valid up to
//! 72 h, 5 min clock skew. Unlocks `J2534`, `UDS_ACTIVE`, `CAN_RE_PRO` offline.
//! No valid lease means COMMUNITY tier with no features.
//!
//! Pairing token (`aud=edge-ws`, `POST /api/v1/auth/edge-pairing`): `user_id`,
//! `tenant_id`, `origin`; lifetime at most 5 min; `origin` must equal the
//! browser's `Origin` header. Native clients (no `Origin`) cannot use one.

use serde_json::{Map, Value};

use super::{
    cloud_keys::KeyRing,
    jws::{self, JwsError},
};
use crate::immo::{IMMO_LEASE_KIND, MAX_IMMO_LEASE_SECS};
use crate::protocol::messages::{Feature, LeaseTier};

pub const SKEW_SECS: u64 = 300;
pub const MAX_LEASE_SECS: u64 = 72 * 3_600;
pub const MAX_PAIRING_SECS: u64 = 300;
pub const LEASE_AUDIENCE: &str = "edge-daemon";
pub const PAIRING_AUDIENCE: &str = "edge-ws";

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    #[error(transparent)]
    Signature(#[from] JwsError),
    #[error("token expired")]
    Expired,
    #[error("token not valid yet")]
    NotYetValid,
    #[error("wrong audience (expected {0})")]
    WrongAudience(&'static str),
    #[error("missing or invalid claim {0}")]
    Claim(&'static str),
    #[error("token lifetime exceeds {0} s")]
    TooLong(u64),
    #[error("token origin does not match the connection")]
    OriginMismatch,
}

/// What a verified lease grants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lease {
    pub tenant_id: Option<String>,
    pub tier: LeaseTier,
    pub features: Vec<Feature>,
    pub aasra_verified: bool,
    /// True when this token is an immobilizer lease, not a diagnostic one.
    pub immo: bool,
    /// Unix seconds; `None` for the no-lease default.
    pub expires_at: Option<u64>,
}

impl Lease {
    /// No lease: COMMUNITY, no features.
    pub fn community() -> Self {
        Self {
            tenant_id: None,
            tier: LeaseTier::Community,
            features: Vec::new(),
            aasra_verified: false,
            immo: false,
            expires_at: None,
        }
    }

    pub fn has(&self, feature: Feature) -> bool {
        self.features.contains(&feature)
    }
}

fn num(claims: &Map<String, Value>, name: &'static str) -> Result<u64, TokenError> {
    claims
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(TokenError::Claim(name))
}

fn string(claims: &Map<String, Value>, name: &'static str) -> Result<String, TokenError> {
    match claims.get(name).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_owned()),
        _ => Err(TokenError::Claim(name)),
    }
}

fn check_audience(claims: &Map<String, Value>, aud: &'static str) -> Result<(), TokenError> {
    let ok = match claims.get("aud") {
        Some(Value::String(s)) => s == aud,
        Some(Value::Array(list)) => list.iter().any(|v| v.as_str() == Some(aud)),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(TokenError::WrongAudience(aud))
    }
}

/// exp/nbf with skew; returns (start, exp).
fn check_times(
    claims: &Map<String, Value>,
    now: u64,
    max_life: u64,
) -> Result<(u64, u64), TokenError> {
    let exp = num(claims, "exp")?;
    let start = match (claims.get("nbf"), claims.get("iat")) {
        (Some(_), _) => num(claims, "nbf")?,
        (None, Some(_)) => num(claims, "iat")?,
        (None, None) => return Err(TokenError::Claim("nbf")),
    };
    if now > exp + SKEW_SECS {
        return Err(TokenError::Expired);
    }
    if now + SKEW_SECS < start {
        return Err(TokenError::NotYetValid);
    }
    if exp.saturating_sub(start) > max_life {
        return Err(TokenError::TooLong(max_life));
    }
    Ok((start, exp))
}

/// Verifies a lease token at time `now` (Unix seconds).
pub fn verify_lease(token: &str, keys: &KeyRing, now: u64) -> Result<Lease, TokenError> {
    let claims = jws::verify(token, keys)?;
    check_audience(&claims, LEASE_AUDIENCE)?;
    let (_, exp) = check_times(&claims, now, MAX_LEASE_SECS)?;
    let tenant_id = string(&claims, "tenant_id")?;
    let tier: LeaseTier =
        serde_json::from_value(claims.get("tier").cloned().unwrap_or(Value::Null))
            .map_err(|_| TokenError::Claim("tier"))?;
    // Unknown feature names (from a newer cloud) are ignored, never trusted.
    let features: Vec<Feature> = claims
        .get("features")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|f| serde_json::from_value(f.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    let aasra_verified = claims
        .get("aasra_verified")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let immo = claims.get("lease_kind").and_then(Value::as_str) == Some(IMMO_LEASE_KIND);
    Ok(Lease {
        tenant_id: Some(tenant_id),
        tier,
        features,
        aasra_verified,
        immo,
        expires_at: Some(exp),
    })
}

/// The lease to use now: a verified token, or COMMUNITY if there is none or it fails.
pub fn effective_lease(token: Option<&str>, keys: &KeyRing, now: u64) -> Lease {
    match token.map(|t| verify_lease(t.trim(), keys, now)) {
        Some(Ok(lease)) if lease.immo => {
            tracing::warn!("immo lease presented as a diagnostic lease; running at COMMUNITY tier");
            Lease::community()
        }
        Some(Ok(lease)) => lease,
        Some(Err(e)) => {
            tracing::warn!("lease rejected ({e}); running at COMMUNITY tier");
            Lease::community()
        }
        None => Lease::community(),
    }
}

/// Claims of a verified cloud pairing token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pairing {
    pub user_id: String,
    pub tenant_id: String,
}

/// Verifies a cloud pairing token for a connection with `origin` (None = native client).
pub fn verify_pairing(
    token: &str,
    keys: &KeyRing,
    origin: Option<&str>,
    now: u64,
) -> Result<Pairing, TokenError> {
    let claims = jws::verify(token, keys)?;
    check_audience(&claims, PAIRING_AUDIENCE)?;
    check_times(&claims, now, MAX_PAIRING_SECS)?;
    let claimed = string(&claims, "origin")?;
    if origin != Some(claimed.as_str()) {
        return Err(TokenError::OriginMismatch);
    }
    Ok(Pairing {
        user_id: string(&claims, "user_id")?,
        tenant_id: string(&claims, "tenant_id")?,
    })
}

/// A verified immobilizer lease (`lease_kind=immo_lease`, `aud=edge-daemon`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImmoLease {
    pub tenant_id: String,
    pub user_id: String,
    pub session_id: String,
    pub jti: String,
    pub vin: String,
    pub device_id: String,
    pub device_tier: String,
    pub oem: String,
    pub operation: String,
    pub expires_at: u64,
}

/// Verifies an immobilizer lease. Diagnostic leases and over-long tokens fail.
pub fn verify_immo_lease(token: &str, keys: &KeyRing, now: u64) -> Result<ImmoLease, TokenError> {
    let claims = jws::verify(token, keys)?;
    check_audience(&claims, LEASE_AUDIENCE)?;
    if claims.get("lease_kind").and_then(Value::as_str) != Some(IMMO_LEASE_KIND) {
        return Err(TokenError::Claim("lease_kind"));
    }
    let (_, exp) = check_times(&claims, now, MAX_IMMO_LEASE_SECS)?;
    if claims.get("aasra_verified").and_then(Value::as_bool) != Some(true) {
        return Err(TokenError::Claim("aasra_verified"));
    }
    Ok(ImmoLease {
        tenant_id: string(&claims, "tenant_id")?,
        user_id: string(&claims, "user_id")?,
        session_id: string(&claims, "session_id")?,
        jti: string(&claims, "jti")?,
        vin: string(&claims, "vin")?,
        device_id: string(&claims, "device_id")?,
        device_tier: string(&claims, "device_tier")?,
        oem: string(&claims, "oem")?,
        operation: string(&claims, "operation")?,
        expires_at: exp,
    })
}


#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;
    use serde_json::json;

    use super::*;

    const NOW: u64 = 1_795_000_000;

    fn setup() -> (SigningKey, KeyRing) {
        let key = SigningKey::from_bytes(&[3; 32]);
        let ring =
            KeyRing::from_raw([("cloud-1".to_owned(), key.verifying_key().to_bytes())]).unwrap();
        (key, ring)
    }

    fn lease_claims() -> Value {
        json!({"aud": "edge-daemon", "tenant_id": "t-1", "tier": "WORKSHOP", "features": ["J2534", "UDS_ACTIVE", "FUTURE_THING"],
               "aasra_verified": true, "nbf": NOW - 60, "exp": NOW + 71 * 3_600})
    }

    #[test]
    fn valid_lease_unlocks_features() {
        let (key, keys) = setup();
        let lease = verify_lease(&jws::sign(&lease_claims(), "cloud-1", &key), &keys, NOW).unwrap();
        assert_eq!(lease.tier, LeaseTier::Workshop);
        assert_eq!(
            lease.features,
            vec![Feature::J2534, Feature::UdsActive],
            "unknown feature ignored"
        );
        assert!(
            lease.aasra_verified && lease.has(Feature::UdsActive) && !lease.has(Feature::CanRePro)
        );
    }

    /// Task 1.4 gate: a lease signed by an unknown key, and an expired lease, are rejected.
    #[test]
    fn rejected_leases() {
        let (key, keys) = setup();
        let rogue = SigningKey::from_bytes(&[4; 32]);
        let sign = |c: Value| jws::sign(&c, "cloud-1", &key);
        assert_eq!(
            verify_lease(&jws::sign(&lease_claims(), "cloud-1", &rogue), &keys, NOW),
            Err(TokenError::Signature(JwsError::BadSignature))
        );
        assert!(matches!(
            verify_lease(&jws::sign(&lease_claims(), "rogue-kid", &rogue), &keys, NOW),
            Err(TokenError::Signature(JwsError::UnknownKey(_)))
        ));

        let mut expired = lease_claims();
        expired["exp"] = json!(NOW - SKEW_SECS - 1);
        expired["nbf"] = json!(NOW - 3_600);
        assert_eq!(
            verify_lease(&sign(expired), &keys, NOW),
            Err(TokenError::Expired)
        );
        // Within the 5 min skew it still counts.
        let mut skewed = lease_claims();
        skewed["exp"] = json!(NOW - 200);
        skewed["nbf"] = json!(NOW - 3_600);
        assert!(verify_lease(&sign(skewed), &keys, NOW).is_ok());

        let mut future = lease_claims();
        future["nbf"] = json!(NOW + SKEW_SECS + 10);
        future["exp"] = json!(NOW + 3_600);
        assert_eq!(
            verify_lease(&sign(future), &keys, NOW),
            Err(TokenError::NotYetValid)
        );
        let mut long = lease_claims();
        long["exp"] = json!(NOW + 73 * 3_600);
        assert_eq!(
            verify_lease(&sign(long), &keys, NOW),
            Err(TokenError::TooLong(MAX_LEASE_SECS))
        );
        let mut aud = lease_claims();
        aud["aud"] = json!("edge-ws");
        assert_eq!(
            verify_lease(&sign(aud), &keys, NOW),
            Err(TokenError::WrongAudience(LEASE_AUDIENCE))
        );
        let mut tenant = lease_claims();
        tenant.as_object_mut().unwrap().remove("tenant_id");
        assert_eq!(
            verify_lease(&sign(tenant), &keys, NOW),
            Err(TokenError::Claim("tenant_id"))
        );
        // A bad lease degrades to COMMUNITY, never fails open.
        assert_eq!(
            effective_lease(Some("garbage"), &keys, NOW),
            Lease::community()
        );
    }

    #[test]
    fn pairing_tokens() {
        let (key, keys) = setup();
        let claims = json!({"aud": "edge-ws", "user_id": "u-1", "tenant_id": "t-1", "origin": "https://app.example", "iat": NOW, "exp": NOW + 300});
        let token = jws::sign(&claims, "cloud-1", &key);
        assert_eq!(
            verify_pairing(&token, &keys, Some("https://app.example"), NOW)
                .unwrap()
                .user_id,
            "u-1"
        );
        assert_eq!(
            verify_pairing(&token, &keys, Some("https://evil.example"), NOW),
            Err(TokenError::OriginMismatch)
        );
        assert_eq!(
            verify_pairing(&token, &keys, None, NOW),
            Err(TokenError::OriginMismatch),
            "native clients use pairing codes"
        );
        let mut long = claims.clone();
        long["exp"] = json!(NOW + 301);
        assert_eq!(
            verify_pairing(
                &jws::sign(&long, "cloud-1", &key),
                &keys,
                Some("https://app.example"),
                NOW
            ),
            Err(TokenError::TooLong(300))
        );
        let lease_token = jws::sign(&lease_claims(), "cloud-1", &key);
        assert!(matches!(
            verify_pairing(&lease_token, &keys, Some("https://app.example"), NOW),
            Err(TokenError::WrongAudience(_))
        ));
    }

    fn immo_claims() -> Value {
        json!({
            "aud": "edge-daemon",
            "lease_kind": "immo_lease",
            "tenant_id": "t-1",
            "user_id": "u-1",
            "session_id": "s-1",
            "jti": "j-1",
            "vin": "SBXTESTVAN0000001",
            "device_id": "RC-DONGLE-SANDBOX",
            "device_tier": "dongle",
            "oem": "SANDBOX",
            "operation": "add_key_onboard",
            "aasra_verified": true,
            "features": ["IMMO_PROGRAM"],
            "nbf": NOW - 10,
            "exp": NOW + 15 * 60
        })
    }

    #[test]
    fn immo_lease_gates() {
        let (key, keys) = setup();
        let sign = |c: Value| jws::sign(&c, "cloud-1", &key);
        let lease = verify_immo_lease(&sign(immo_claims()), &keys, NOW).unwrap();
        assert_eq!(lease.vin, "SBXTESTVAN0000001");
        assert_eq!(lease.device_id, "RC-DONGLE-SANDBOX");

        // A diagnostic lease is not an immo lease.
        assert_eq!(
            verify_immo_lease(&sign(lease_claims()), &keys, NOW),
            Err(TokenError::Claim("lease_kind"))
        );

        // Longer than 30 minutes is refused.
        let mut long = immo_claims();
        long["exp"] = json!(NOW + 31 * 60);
        assert_eq!(
            verify_immo_lease(&sign(long), &keys, NOW),
            Err(TokenError::TooLong(MAX_IMMO_LEASE_SECS))
        );

        // VIN binding is required.
        let mut no_vin = immo_claims();
        no_vin["vin"] = json!("");
        assert_eq!(
            verify_immo_lease(&sign(no_vin), &keys, NOW),
            Err(TokenError::Claim("vin"))
        );

        // An immo lease must not unlock diagnostic features.
        assert_eq!(
            effective_lease(Some(&sign(immo_claims())), &keys, NOW),
            Lease::community()
        );
    }
}
