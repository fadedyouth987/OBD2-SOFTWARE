//! Development-only cloud keys (UI wiring work).
//!
//! A debug build reads `EDGE_DEV_CLOUD_KEYS` (`kid:64-hex,kid:64-hex`) and
//! trusts those Ed25519 public keys *in addition to* the pinned
//! [`CLOUD_KEYS`](super::cloud_keys::CLOUD_KEYS). That lets a developer run the
//! whole lease flow (Billing -> lease -> daemon) against a local cloud API.
//!
//! Release builds ignore the variable entirely (`cfg!(debug_assertions)`), so
//! it can never widen trust on a shipped daemon. Kept apart from
//! `cloud_keys.rs` because `scripts/export_cloud_keys.py` regenerates that file.

use ed25519_dalek::VerifyingKey;

use super::cloud_keys::{KeyRing, CLOUD_KEYS};

pub const ENV: &str = "EDGE_DEV_CLOUD_KEYS";

/// Pinned keys, plus the development keys from [`ENV`] on a debug build.
pub fn keyring() -> KeyRing {
    let pinned = || CLOUD_KEYS.iter().map(|k| (k.kid.to_owned(), k.public_key));
    if !cfg!(debug_assertions) {
        return KeyRing::production();
    }
    let Ok(raw) = std::env::var(ENV) else {
        return KeyRing::production();
    };
    if raw.trim().is_empty() {
        return KeyRing::production();
    }
    match parse(&raw) {
        Ok(extra) => {
            let kids: Vec<&str> = extra.iter().map(|(k, _)| k.as_str()).collect();
            tracing::warn!(
                kids = %kids.join(","),
                "DEBUG BUILD: also trusting development cloud keys from {ENV}"
            );
            KeyRing::from_raw(pinned().chain(extra)).unwrap_or_else(|_| KeyRing::production())
        }
        Err(e) => {
            tracing::error!("{ENV} ignored: {e}");
            KeyRing::production()
        }
    }
}

/// Parses `kid:64-hex-chars` pairs separated by commas into validated raw keys.
pub fn parse(raw: &str) -> Result<Vec<(String, [u8; 32])>, String> {
    raw.split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (kid, hex) = pair
                .split_once(':')
                .ok_or_else(|| format!("{pair:?} is not kid:hex"))?;
            let (kid, hex) = (kid.trim(), hex.trim());
            if kid.is_empty() || hex.len() != 64 || !hex.is_ascii() {
                return Err(format!("{pair:?} needs a kid and a 32-byte hex key"));
            }
            let mut key = [0u8; 32];
            for (i, byte) in key.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                    .map_err(|_| format!("{pair:?} has a non-hex key"))?;
            }
            VerifyingKey::from_bytes(&key).map_err(|e| format!("{pair:?}: {e}"))?;
            Ok((kid.to_owned(), key))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_keys_and_rejects_garbage() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]).verifying_key();
        let hex: String = key.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let parsed = parse(&format!("dev-1:{hex}, ")).unwrap();
        assert_eq!(parsed, vec![("dev-1".to_owned(), *key.as_bytes())]);
        assert!(parse("nocolon").is_err());
        assert!(parse("k:abcd").is_err());
        assert!(parse(&format!("k:{}", "zz".repeat(32))).is_err());
        assert!(parse(&format!(":{hex}")).is_err());
    }
}
