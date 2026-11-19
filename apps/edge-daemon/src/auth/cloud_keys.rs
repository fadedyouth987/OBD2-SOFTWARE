//! Pinned cloud signing keys (Task 1.4). Task 2.2's `signing.py` exports the
//! production public key and its `kid` into [`CLOUD_KEYS`] at build time.
//!
//! Until then the list is empty: no lease or cloud pairing token verifies, so
//! the daemon runs at COMMUNITY tier and accepts only local pairing codes.
//! That is the safe default. No private key is ever in this repository.

use ed25519_dalek::VerifyingKey;

/// One pinned public key.
pub struct CloudKey {
    pub kid: &'static str,
    /// Raw 32-byte Ed25519 public key.
    pub public_key: [u8; 32],
}

/// Production keys, newest first. Filled by Task 2.2.
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
