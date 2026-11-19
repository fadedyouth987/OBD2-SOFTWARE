//! Typed view of `safety_policy.json` (Rule 3). Nothing here duplicates the
//! gated list: every lookup goes to the embedded policy file.

use std::time::Duration;

use crate::protocol::{self, messages::DiagProtocol, policy_types::TierRequirements};

/// Preconditions for one tier, from the policy file.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TierRules {
    pub requires_token: bool,
    pub max_speed_kmh: f64,
    /// Rule 5: a speed reading older than this counts as unknown.
    pub max_speed_age: Duration,
    pub max_rpm: Option<f64>,
    pub min_battery_v: Option<f64>,
}

impl From<&TierRequirements> for TierRules {
    fn from(t: &TierRequirements) -> Self {
        Self {
            requires_token: t.requires_safety_token,
            max_speed_kmh: t.max_speed_kmh,
            max_speed_age: Duration::from_millis(t.max_speed_age_ms),
            max_rpm: t.max_rpm,
            min_battery_v: t.min_battery_v,
        }
    }
}

/// How the policy treats one request.
#[derive(Clone, Debug, PartialEq)]
pub enum Gating {
    /// Not in the policy: sent without checks.
    Ungated,
    /// Ungated but every use is logged (UDS 0x10 0x03).
    Logged { name: String },
    /// Gated: needs a token and the tier's preconditions.
    Gated {
        name: String,
        tier: char,
        rules: TierRules,
    },
}

impl Gating {
    pub fn is_gated(&self) -> bool {
        matches!(self, Self::Gated { .. })
    }
}

/// Single-use token lifetime.
pub fn token_ttl() -> Duration {
    Duration::from_secs(u64::from(protocol::safety_policy().token_ttl_s.get()))
}

fn hex_byte(text: &str) -> u8 {
    u8::from_str_radix(text.trim_start_matches("0x"), 16)
        .expect("policy hex bytes are schema-validated")
}

/// The sub-function byte the policy compares: UDS masks the
/// suppressPosRspMsgIndicationBit; KWP2000 sub-functions use bit 7 (0x85).
pub fn sub_function(protocol: DiagProtocol, payload: &[u8]) -> Option<u8> {
    let sub = *payload.get(1)?;
    Some(if protocol == DiagProtocol::Uds {
        sub & 0x7F
    } else {
        sub
    })
}

/// Classifies a request payload (first byte = service id / OBD mode).
pub fn classify(protocol: DiagProtocol, payload: &[u8]) -> Gating {
    let Some(&sid) = payload.first() else {
        return Gating::Ungated;
    };
    let sub = sub_function(protocol, payload);
    if let Some(rule) = protocol::gated_rule(protocol, sid, sub) {
        let tiers = &protocol::safety_policy().tiers;
        let (tier, req) = match rule.tier {
            protocol::policy_types::Tier::A => ('A', &tiers.a),
            protocol::policy_types::Tier::B => ('B', &tiers.b),
        };
        return Gating::Gated {
            name: rule.name.to_string(),
            tier,
            rules: req.into(),
        };
    }
    let proto = protocol.to_string();
    let logged = protocol::safety_policy().logged_ungated.iter().find(|l| {
        l.protocol.to_string() == proto
            && hex_byte(&l.service_id) == sid
            && l.sub_function
                .as_ref()
                .is_none_or(|s| Some(hex_byte(s)) == sub)
    });
    match logged {
        Some(l) => Gating::Logged {
            name: l.name.to_string(),
        },
        None => Gating::Ungated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classification() {
        assert_eq!(
            classify(DiagProtocol::Uds, &[0x22, 0xF1, 0x90]),
            Gating::Ungated
        );
        assert!(matches!(
            classify(DiagProtocol::Uds, &[0x10, 0x03]),
            Gating::Logged { .. }
        ));
        // Suppress bit does not dodge the gate.
        assert!(matches!(
            classify(DiagProtocol::Uds, &[0x10, 0x82]),
            Gating::Gated { tier: 'B', .. }
        ));
        assert!(matches!(
            classify(DiagProtocol::Kwp2000, &[0x10, 0x85]),
            Gating::Gated { tier: 'B', .. }
        ));
        assert!(matches!(
            classify(DiagProtocol::Kwp2000, &[0x10, 0x89]),
            Gating::Ungated
        ));
        let Gating::Gated { rules, .. } = classify(DiagProtocol::Uds, &[0x2F, 0x0B, 0x2A, 0x03])
        else {
            panic!()
        };
        assert_eq!(
            (rules.max_speed_kmh, rules.max_speed_age),
            (0.0, Duration::from_millis(2_000))
        );
        assert!(classify(DiagProtocol::Obd, &[0x04]).is_gated());
        assert_eq!(classify(DiagProtocol::Uds, &[]), Gating::Ungated);
        assert_eq!(token_ttl(), Duration::from_secs(60));
    }
}
