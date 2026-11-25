//! Offline authorization (Task 1.4): Ed25519-signed tokens from the cloud.
//!
//! - [`jws`]: compact JWS verification, Ed25519 (`alg: EdDSA`) only. A general
//!   JWT library is deliberately not used: accepting exactly one algorithm with
//!   a pinned key rules out algorithm-confusion and `alg: none` attacks, and
//!   avoids pulling RSA code into a privileged local service.
//! - [`cloud_keys`]: the pinned cloud public keys, chosen by `kid`.
//! - [`lease`]: offline capability leases (`aud=edge-daemon`, up to 72 h) and
//!   cloud pairing tokens for the local WebSocket (`aud=edge-ws`, up to 5 min).

pub mod cloud_keys;
pub mod dev_keys;
pub mod jws;
pub mod lease;

/// Seconds since the Unix epoch.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
