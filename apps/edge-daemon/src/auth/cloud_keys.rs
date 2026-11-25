//! Pinned cloud signing keys (Task 1.4).
//!
//! [`CLOUD_KEYS`] stays empty on purpose: an empty ring means no cloud-issued
//! lease or pairing token will verify, so the daemon stays on the COMMUNITY
//! tier and accepts only local pairing codes. That is the safe default.
//!
//! Pin a key only when you intend every lease signed by the matching
//! *private* key (held in `CLOUD_SIGNING_PRIVATE_KEY_HEX` on the API, never
//! in this repository) to be accepted on the vehicle. Use
//! `scripts/export_cloud_keys.py` with the public half of a production key
//! stored in a secret manager — never a development key, and never a key
//! that was used while unauthenticated lease issuance existed.
//!
//! No private key is ever in this repository.

use ed25519_dalek::VerifyingKey;

/// One pinned public key.
pub struct CloudKey {
    pub kid: &'static str,
    /// Raw 32-byte Ed25519 public key.
    pub public_key: [u8; 32],
}

/// Production keys, newest first. Leave empty unless you have deliberately pinned a production public key.
pub const CLOUD_KEYS: &[CloudKey] = &[];

/// Keys trusted for verification, by `kid`.
#[derive(Clone, Debug, Default)]
pub struct KeyRing {
    keys: Vec<(String, VerifyingKey)>,
}

impl KeyRing {
    /// The pinned production keys.
    pub fn production() -> Self {
        Self::from_raw(CLOUD_KEYS.iter().map(|k| (k.kid.to_owned(), k.public_key)))
            .expect("pinned cloud keys are valid Ed25519 points")
    }

    /// Builds a ring from raw keys (tests, staging).
    pub fn from_raw(
        keys: impl IntoIterator<Item = (String, [u8; 32])>,
    ) -> Result<Self, ed25519_dalek::SignatureError> {
        let keys = keys
            .into_iter()
            .map(|(kid, raw)| Ok((kid, VerifyingKey::from_bytes(&raw)?)))
            .collect::<Result<_, ed25519_dalek::SignatureError>>()?;
        Ok(Self { keys })
    }

    pub fn get(&self, kid: &str) -> Option<&VerifyingKey> {
        self.keys.iter().find(|(k, _)| k == kid).map(|(_, v)| v)
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}
