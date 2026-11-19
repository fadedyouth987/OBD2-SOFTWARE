//! Compact JWS with Ed25519 only (`alg: EdDSA`, RFC 8037).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, Signer, SigningKey};
use serde_json::{Map, Value};

use super::cloud_keys::KeyRing;

/// Tokens longer than this are refused before any parsing.
pub const MAX_TOKEN_LEN: usize = 8_192;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum JwsError {
    #[error("malformed token")]
    Malformed,
    #[error("unsupported algorithm {0:?} (only EdDSA)")]
    UnsupportedAlg(String),
    #[error("unknown signing key {0:?}")]
    UnknownKey(String),
    #[error("bad signature")]
    BadSignature,
}

fn decode_json(part: &str) -> Result<Map<String, Value>, JwsError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| JwsError::Malformed)?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(JwsError::Malformed),
    }
}

/// Verifies the signature and returns the claims. Time and audience checks
/// are the caller's (see `lease`).
pub fn verify(token: &str, keys: &KeyRing) -> Result<Map<String, Value>, JwsError> {
    if token.len() > MAX_TOKEN_LEN {
        return Err(JwsError::Malformed);
    }
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(JwsError::Malformed);
    };
    let header = decode_json(h)?;
    match header.get("alg").and_then(Value::as_str) {
        Some("EdDSA") => {}
        other => {
            return Err(JwsError::UnsupportedAlg(
                other.unwrap_or("missing").to_owned(),
            ))
        }
    }
    if header.get("crit").is_some() {
        return Err(JwsError::Malformed); // no critical extensions understood
    }
    let kid = header
        .get("kid")
        .and_then(Value::as_str)
        .ok_or(JwsError::Malformed)?;
    let key = keys
        .get(kid)
        .ok_or_else(|| JwsError::UnknownKey(kid.to_owned()))?;
    let sig_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|_| JwsError::Malformed)?
        .try_into()
        .map_err(|_| JwsError::Malformed)?;
    let signed = &token[..h.len() + 1 + p.len()];
    key.verify_strict(signed.as_bytes(), &Signature::from_bytes(&sig_bytes))
        .map_err(|_| JwsError::BadSignature)?;
    decode_json(p)
}

/// Signs claims (cloud side does this in Task 2.2; tests and dev tools use it here).
pub fn sign(claims: &Value, kid: &str, key: &SigningKey) -> String {
    let header = serde_json::json!({ "alg": "EdDSA", "typ": "JWT", "kid": kid });
    let h = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).expect("serializes"));
    let p = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).expect("serializes"));
    let signed = format!("{h}.{p}");
    let sig = key.sign(signed.as_bytes());
    format!("{signed}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ring(seed: u8) -> (SigningKey, KeyRing) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let ring = KeyRing::from_raw([("k1".to_owned(), key.verifying_key().to_bytes())]).unwrap();
        (key, ring)
    }

    #[test]
    fn sign_verify_and_tamper() {
        let (key, keys) = ring(7);
        let token = sign(&serde_json::json!({"sub": "x"}), "k1", &key);
        assert_eq!(verify(&token, &keys).unwrap()["sub"], "x");

        // Tampered payload.
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(br#"{"sub":"admin"}"#);
        parts[1] = &forged;
        assert_eq!(verify(&parts.join("."), &keys), Err(JwsError::BadSignature));
        // Unknown kid, other key, alg none, garbage.
        assert!(matches!(
            verify(&sign(&serde_json::json!({}), "k2", &key), &keys),
            Err(JwsError::UnknownKey(_))
        ));
        let (other, _) = ring(9);
        assert_eq!(
            verify(&sign(&serde_json::json!({}), "k1", &other), &keys),
            Err(JwsError::BadSignature)
        );
        let none = format!(
            "{}.{}.",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"none","kid":"k1"}"#),
            URL_SAFE_NO_PAD.encode(b"{}")
        );
        assert!(matches!(
            verify(&none, &keys),
            Err(JwsError::UnsupportedAlg(_))
        ));
        let hs = format!(
            "{}.{}.AAAA",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","kid":"k1"}"#),
            URL_SAFE_NO_PAD.encode(b"{}")
        );
        assert!(matches!(
            verify(&hs, &keys),
            Err(JwsError::UnsupportedAlg(_))
        ));
        assert_eq!(verify("a.b", &keys), Err(JwsError::Malformed));
        assert_eq!(verify(&"x".repeat(9_000), &keys), Err(JwsError::Malformed));
        assert!(
            KeyRing::production().is_empty(),
            "no production key until Task 2.2"
        );
    }
}
