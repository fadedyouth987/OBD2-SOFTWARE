//! Phone access over the local network (opt-in). See
//! `docs/design/lan-phone-access.md` for the threat model.
//!
//! Off by default. When a technician turns it on (`edge-daemon lan enable`,
//! or `EDGE_LAN=on`), the daemon also listens on the workshop network
//! (default port 8766), and only over TLS with a self-signed certificate made
//! for this daemon. Nothing about the loopback listener changes.
//!
//! - **Pairing.** The PC shows a QR code (web Devices page, or `edge-daemon lan
//!   pair`) holding the PC's address, the SHA-256 fingerprint of its
//!   certificate and a one-time pairing token (256-bit, 5 minutes, single
//!   use). The phone connects pinned to that fingerprint, presents the token,
//!   and gets a device credential (`lan_<id>.<secret>`) that it keeps in the
//!   Android keystore. Only the SHA-256 of the secret is stored here.
//! - **Every later connection** presents that credential in the WebSocket
//!   upgrade (`Authorization: Bearer ...`), with the web app's `Origin`. A
//!   peer without one never gets a WebSocket: it gets HTTP 401 and counts
//!   towards its address's failure limit.
//! - **Who is working** still comes from the cloud pairing JWT in
//!   `HelloRequest`, so each technician runs under their own lease, exactly as
//!   in the browser. Six-digit local codes are refused on the network.
//! - **Revoking** a phone (web Devices page or `edge-daemon lan revoke`)
//!   deletes its credential and closes its open connections at once.
//!
//! Car writes from a phone go through the same `SafetyInterlock`, safety
//! tokens and audit log as the browser; the audit records name the phone.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

use super::pairing::file_mode;

pub const DEFAULT_LAN_PORT: u16 = 8766;
/// How long a pairing QR code works.
pub const OFFER_TTL: Duration = Duration::from_secs(300);
/// Pairing codes outstanding at once; issuing more drops the oldest.
pub const MAX_LIVE_OFFERS: usize = 3;
/// Phones one daemon remembers.
pub const MAX_DEVICES: usize = 32;
/// A TCP connection that hasn't finished TLS by then is dropped.
pub const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Network connections open at once (all phones together).
pub const MAX_LAN_CONNECTIONS: usize = 16;
/// New connections per minute from one address.
pub const CONNECTS_PER_MINUTE: u32 = 30;
/// Failed authentications from one address before it is blocked.
pub const MAX_AUTH_FAILURES: u32 = 5;
/// How long a blocked address stays blocked.
pub const BLOCK_FOR: Duration = Duration::from_secs(300);
/// mDNS service type (when `mdns` is on).
pub const MDNS_SERVICE: &str = "_rootcause-edge._tcp.local.";
/// Scheme and path of the pairing link inside the QR code.
pub const PAIR_URI_PREFIX: &str = "rootcause://lan-pair?";

/// `<data dir>/lan`: certificate, key, phone registry, settings. Service-only.
pub fn lan_dir(dir: &Path) -> PathBuf {
    dir.join("lan")
}

/// Pairing offers live beside the local pairing codes, in the folder the
/// installed service shares with technicians, so `edge-daemon lan pair`
/// works for a technician like `edge-daemon pair` does.
pub fn offers_path(dir: &Path) -> PathBuf {
    dir.join("pairing").join("lan_offers.json")
}

/// Public facts `edge-daemon lan pair` needs (port, fingerprint, name),
/// written by the running daemon into the shared pairing folder.
pub fn info_path(dir: &Path) -> PathBuf {
    dir.join("pairing").join("lan_info.json")
}

pub fn config_path(dir: &Path) -> PathBuf {
    lan_dir(dir).join("config.json")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).expect("OS random source available");
    b
}

/// Equal-length comparison that doesn't stop at the first difference.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Keeps letters, digits, space, dot, dash and underscore; at most `max` chars.
pub fn clean_name(raw: &str, max: usize, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_'))
        .take(max)
        .collect();
    let cleaned = cleaned.trim().to_owned();
    if cleaned.is_empty() {
        fallback.to_owned()
    } else {
        cleaned
    }
}

fn on_off(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "on" | "true" | "yes" => Some(true),
        "0" | "off" | "false" | "no" => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Settings

/// `lan/config.json`, written by `edge-daemon lan enable|disable`.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LanConfigFile {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mdns: bool,
    #[serde(default)]
    pub port: Option<u16>,
}

impl LanConfigFile {
    pub fn load(dir: &Path) -> Self {
        std::fs::read_to_string(config_path(dir))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> std::io::Result<()> {
        crate::fsutil::write_atomic(
            &config_path(dir),
            &serde_json::to_vec_pretty(self).expect("serializes"),
            0o600,
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanSettings {
    pub enabled: bool,
    pub port: u16,
    /// Address the network listener binds (default every IPv4 interface).
    pub bind: IpAddr,
    /// Advertise on mDNS so a phone finds the PC after its address changes.
    pub mdns: bool,
    /// Address to put in the QR code instead of the detected one (VPNs, NAT).
    pub advertised_host: Option<IpAddr>,
    /// Name shown on the phone.
    pub name: String,
}

impl LanSettings {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_LAN_PORT,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            mdns: false,
            advertised_host: None,
            name: default_name(&|_| None),
        }
    }

    /// The config file, overridden by `EDGE_LAN`, `EDGE_LAN_PORT`,
    /// `EDGE_LAN_BIND`, `EDGE_LAN_MDNS`, `EDGE_LAN_HOST` and `EDGE_LAN_NAME`.
    pub fn resolve(file: &LanConfigFile, env: &dyn Fn(&str) -> Option<String>) -> Self {
        let enabled = env("EDGE_LAN")
            .and_then(|v| on_off(&v))
            .unwrap_or(file.enabled);
        let mdns = env("EDGE_LAN_MDNS")
            .and_then(|v| on_off(&v))
            .unwrap_or(file.mdns);
        let port = env("EDGE_LAN_PORT")
            .and_then(|v| v.trim().parse().ok())
            .or(file.port)
            .unwrap_or(DEFAULT_LAN_PORT);
        let bind = env("EDGE_LAN_BIND")
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        let advertised_host = env("EDGE_LAN_HOST").and_then(|v| v.trim().parse().ok());
        Self {
            enabled,
            port,
            bind,
            mdns,
            advertised_host,
            name: default_name(env),
        }
    }
}

fn default_name(env: &dyn Fn(&str) -> Option<String>) -> String {
    let raw = env("EDGE_LAN_NAME")
        .or_else(|| env("COMPUTERNAME"))
        .or_else(|| env("HOSTNAME"))
        .or_else(|| {
            std::fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_owned())
        })
        .unwrap_or_default();
    clean_name(&raw, 32, "RootCause PC")
}

/// Process environment, for [`LanSettings::resolve`].
pub fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

// ---------------------------------------------------------------------------
// Identity: certificate, key, daemon id

#[derive(Clone)]
pub struct LanIdentity {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
    /// SHA-256 of the certificate (DER), lowercase hex. What the phone pins.
    pub fingerprint: String,
    /// Stable id for this daemon, `rcd_` + 16 hex; in the QR code and mDNS.
    pub daemon_id: String,
}

impl std::fmt::Debug for LanIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LanIdentity")
            .field("fingerprint", &self.fingerprint)
            .field("daemon_id", &self.daemon_id)
            .finish_non_exhaustive()
    }
}

impl LanIdentity {
    /// A fresh self-signed ECDSA P-256 certificate (TLS 1.2 phones need ECDSA
    /// or RSA; P-256 is the smallest both ends accept).
    pub fn generate() -> std::io::Result<Self> {
        let daemon_id = format!("rcd_{}", hex(&random_bytes::<8>()));
        let ck = rcgen::generate_simple_self_signed(vec![
            "rootcause-edge.local".to_owned(),
            format!("{daemon_id}.local"),
        ])
        .map_err(std::io::Error::other)?;
        let cert_der = ck.cert.der().to_vec();
        Ok(Self {
            fingerprint: sha256_hex(&cert_der),
            key_der: ck.signing_key.serialize_der(),
            cert_der,
            daemon_id,
        })
    }

    /// Loads `lan/cert.der`, `lan/key.der` and `lan/daemon_id`, creating them
    /// the first time.
    pub fn load_or_create(dir: &Path) -> std::io::Result<Self> {
        let lan = lan_dir(dir);
        let (cert, key, id) = (
            lan.join("cert.der"),
            lan.join("key.der"),
            lan.join("daemon_id"),
        );
        if let (Ok(cert_der), Ok(key_der), Ok(daemon_id)) = (
            std::fs::read(&cert),
            std::fs::read(&key),
            std::fs::read_to_string(&id),
        ) {
            let daemon_id = daemon_id.trim().to_owned();
            if !cert_der.is_empty() && !key_der.is_empty() && valid_daemon_id(&daemon_id) {
                return Ok(Self {
                    fingerprint: sha256_hex(&cert_der),
                    cert_der,
                    key_der,
                    daemon_id,
                });
            }
        }
        let fresh = Self::generate()?;
        crate::fsutil::write_atomic(&key, &fresh.key_der, 0o600)?;
        crate::fsutil::write_atomic(&cert, &fresh.cert_der, 0o600)?;
        crate::fsutil::write_atomic(&id, fresh.daemon_id.as_bytes(), 0o600)?;
        tracing::info!(fingerprint = %fresh.fingerprint, "created the network certificate for phone access");
        Ok(fresh)
    }

    /// Deletes the certificate and every paired phone (they must pair again).
    pub fn rotate(dir: &Path) -> std::io::Result<()> {
        let lan = lan_dir(dir);
        for f in ["cert.der", "key.der", "daemon_id", "devices.json"] {
            match std::fs::remove_file(lan.join(f)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    pub fn tls_config(&self) -> Result<rustls::ServerConfig, rustls::Error> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(self.key_der.clone()),
        );
        let cert = rustls::pki_types::CertificateDer::from(self.cert_der.clone());
        let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])?
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)?;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(cfg)
    }
}

pub fn valid_daemon_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("rcd_")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ---------------------------------------------------------------------------
// Paired phones

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeviceRecord {
    /// `lan_` + 16 hex.
    pub id: String,
    pub name: String,
    /// SHA-256 (hex) of the device secret; the secret itself is never stored.
    pub secret_sha256: String,
    pub paired_at: u64,
    pub last_seen_at: Option<u64>,
    /// Cloud user who created the pairing code, when it came from the web app.
    pub paired_by: Option<String>,
    /// Workshop the phone works for. Set by the pairing code's creator, or by
    /// the first technician to connect when the code came from the command line.
    pub tenant_id: Option<String>,
}

pub fn valid_device_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("lan_")
        && id[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A device credential sent as `Authorization: Bearer <id>.<secret>`.
pub fn parse_credential(value: &str) -> Option<(&str, &str)> {
    let (id, secret) = value.split_once('.')?;
    (valid_device_id(id)
        && secret.len() == 43
        && secret
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
    .then_some((id, secret))
}

#[derive(Debug, PartialEq, Eq)]
pub enum TenantCheck {
    Ok,
    /// The phone was paired for another workshop.
    Mismatch,
    /// The phone has been revoked meanwhile.
    Unknown,
}

/// Paired phones, in `lan/devices.json` (owner-only).
pub struct DeviceRegistry {
    path: Option<PathBuf>,
    devices: Mutex<Vec<DeviceRecord>>,
    connected: Mutex<HashMap<String, usize>>,
    last_saved_seen: Mutex<HashMap<String, u64>>,
    revoked: broadcast::Sender<String>,
}

impl DeviceRegistry {
    pub fn in_memory() -> Self {
        Self::with_path(None, Vec::new())
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let devices = read_devices(&path);
        Self::with_path(Some(path), devices)
    }

    fn with_path(path: Option<PathBuf>, devices: Vec<DeviceRecord>) -> Self {
        let (revoked, _) = broadcast::channel(64);
        Self {
            path,
            devices: Mutex::new(devices),
            connected: Mutex::default(),
            last_saved_seen: Mutex::default(),
            revoked,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<DeviceRecord>> {
        self.devices.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, devices: &[DeviceRecord]) -> std::io::Result<()> {
        match &self.path {
            None => Ok(()),
            Some(p) => crate::fsutil::write_atomic(
                p,
                &serde_json::to_vec_pretty(devices).expect("serializes"),
                0o600,
            ),
        }
    }

    pub fn list(&self) -> Vec<DeviceRecord> {
        self.lock().clone()
    }

    pub fn connected_count(&self, id: &str) -> usize {
        self.connected
            .lock()
            .map(|m| m.get(id).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    /// Adds a phone and returns `(device_id, device_secret)`. The oldest phone
    /// is dropped past [`MAX_DEVICES`].
    pub fn add(
        &self,
        name: &str,
        paired_by: Option<String>,
        tenant_id: Option<String>,
        now: u64,
    ) -> std::io::Result<(String, String)> {
        let id = format!("lan_{}", hex(&random_bytes::<8>()));
        let secret = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
        let mut devices = self.lock();
        let mut next = devices.clone();
        next.push(DeviceRecord {
            id: id.clone(),
            name: clean_name(name, 48, "Phone"),
            secret_sha256: sha256_hex(secret.as_bytes()),
            paired_at: now,
            last_seen_at: None,
            paired_by,
            tenant_id,
        });
        let mut dropped = Vec::new();
        while next.len() > MAX_DEVICES {
            dropped.push(next.remove(0).id);
        }
        self.save(&next)?;
        *devices = next;
        drop(devices);
        for d in dropped {
            let _ = self.revoked.send(d);
        }
        Ok((id, secret))
    }

    /// The phone a credential belongs to, if it is still paired.
    pub fn authenticate(&self, credential: &str) -> Option<DeviceRecord> {
        let (id, secret) = parse_credential(credential)?;
        let wanted = sha256_hex(secret.as_bytes());
        self.lock()
            .iter()
            .find(|d| d.id == id && ct_eq(d.secret_sha256.as_bytes(), wanted.as_bytes()))
            .cloned()
    }

    pub fn get(&self, id: &str) -> Option<DeviceRecord> {
        self.lock().iter().find(|d| d.id == id).cloned()
    }

    /// Checks (and on first use records) the workshop a phone works for.
    pub fn check_tenant(&self, id: &str, tenant: &str) -> TenantCheck {
        let mut devices = self.lock();
        let Some(i) = devices.iter().position(|d| d.id == id) else {
            return TenantCheck::Unknown;
        };
        match devices[i].tenant_id.as_deref() {
            Some(t) if t == tenant => TenantCheck::Ok,
            Some(_) => TenantCheck::Mismatch,
            None => {
                let mut next = devices.clone();
                next[i].tenant_id = Some(tenant.to_owned());
                if let Err(e) = self.save(&next) {
                    tracing::error!("could not record the phone's workshop: {e}");
                    return TenantCheck::Mismatch; // fail closed
                }
                *devices = next;
                TenantCheck::Ok
            }
        }
    }

    /// Notes that a phone connected (saved at most once a minute per phone).
    pub fn touch(&self, id: &str, now: u64) {
        let mut devices = self.lock();
        let Some(d) = devices.iter_mut().find(|d| d.id == id) else {
            return;
        };
        d.last_seen_at = Some(now);
        let due = self
            .last_saved_seen
            .lock()
            .map(|m| m.get(id).is_none_or(|t| now >= t + 60))
            .unwrap_or(true);
        if due {
            let snapshot = devices.clone();
            drop(devices);
            if self.save(&snapshot).is_ok() {
                if let Ok(mut m) = self.last_saved_seen.lock() {
                    m.insert(id.to_owned(), now);
                }
            }
        }
    }

    /// Removes a phone and closes its open connections. False if unknown.
    pub fn revoke(&self, id: &str) -> std::io::Result<bool> {
        let mut devices = self.lock();
        let next: Vec<DeviceRecord> = devices.iter().filter(|d| d.id != id).cloned().collect();
        if next.len() == devices.len() {
            return Ok(false);
        }
        self.save(&next)?;
        *devices = next;
        drop(devices);
        let _ = self.revoked.send(id.to_owned());
        tracing::info!(device = %id, "phone access revoked");
        Ok(true)
    }

    /// Re-reads the file (after `edge-daemon lan revoke` edits it) and closes
    /// connections of phones that are gone. Returns the removed ids.
    pub fn reload(&self) -> Vec<String> {
        let Some(path) = &self.path else {
            return Vec::new();
        };
        let on_disk = read_devices(path);
        let mut devices = self.lock();
        let removed: Vec<String> = devices
            .iter()
            .filter(|d| !on_disk.iter().any(|o| o.id == d.id))
            .map(|d| d.id.clone())
            .collect();
        // Keep in-memory last-seen times newer than the file's.
        let merged: Vec<DeviceRecord> = on_disk
            .into_iter()
            .map(|mut o| {
                if let Some(mem) = devices.iter().find(|d| d.id == o.id) {
                    o.last_seen_at = o.last_seen_at.max(mem.last_seen_at);
                }
                o
            })
            .collect();
        *devices = merged;
        drop(devices);
        for id in &removed {
            let _ = self.revoked.send(id.clone());
            tracing::info!(device = %id, "phone removed from the registry; closing its connections");
        }
        removed
    }

    /// Ids of phones as they are revoked.
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    /// Counts an open connection until the returned guard drops.
    pub fn connected(self: &Arc<Self>, id: &str) -> ConnectedGuard {
        if let Ok(mut m) = self.connected.lock() {
            *m.entry(id.to_owned()).or_insert(0) += 1;
        }
        ConnectedGuard {
            registry: Arc::clone(self),
            id: id.to_owned(),
        }
    }
}

fn read_devices(path: &Path) -> Vec<DeviceRecord> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<DeviceRecord>>(&t).ok())
        .map(|v| v.into_iter().filter(|d| valid_device_id(&d.id)).collect())
        .unwrap_or_default()
}

pub struct ConnectedGuard {
    registry: Arc<DeviceRegistry>,
    id: String,
}

impl Drop for ConnectedGuard {
    fn drop(&mut self) {
        if let Ok(mut m) = self.registry.connected.lock() {
            if let Some(n) = m.get_mut(&self.id) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    m.remove(&self.id);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pairing offers (one-time tokens behind the QR code)

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OfferEntry {
    sha256: String,
    pub expires_at: u64,
    pub paired_by: Option<String>,
    pub tenant_id: Option<String>,
}

pub struct OfferStore {
    path: Option<PathBuf>,
    memory: Mutex<Vec<OfferEntry>>,
    lock: Mutex<()>,
}

impl OfferStore {
    pub fn in_memory() -> Self {
        Self {
            path: None,
            memory: Mutex::default(),
            lock: Mutex::default(),
        }
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
            memory: Mutex::default(),
            lock: Mutex::default(),
        }
    }

    fn load(&self) -> Vec<OfferEntry> {
        match &self.path {
            None => self.memory.lock().map(|m| m.clone()).unwrap_or_default(),
            Some(p) => std::fs::read_to_string(p)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default(),
        }
    }

    fn save(&self, entries: &[OfferEntry]) -> std::io::Result<()> {
        match &self.path {
            None => {
                if let Ok(mut m) = self.memory.lock() {
                    *m = entries.to_vec();
                }
                Ok(())
            }
            Some(p) => crate::fsutil::write_atomic(
                p,
                &serde_json::to_vec(entries).expect("serializes"),
                file_mode(p),
            ),
        }
    }

    /// A new single-use token valid for [`OFFER_TTL`].
    pub fn issue(
        &self,
        now: u64,
        paired_by: Option<String>,
        tenant_id: Option<String>,
    ) -> std::io::Result<(String, u64)> {
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let mut entries: Vec<OfferEntry> = self
            .load()
            .into_iter()
            .filter(|e| e.expires_at > now)
            .collect();
        let token = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
        let expires_at = now + OFFER_TTL.as_secs();
        entries.push(OfferEntry {
            sha256: sha256_hex(token.as_bytes()),
            expires_at,
            paired_by,
            tenant_id,
        });
        while entries.len() > MAX_LIVE_OFFERS {
            entries.remove(0);
        }
        self.save(&entries)?;
        Ok((token, expires_at))
    }

    /// Burns `token` and returns who made it. Fails closed if it can't be burnt.
    pub fn consume(&self, token: &str, now: u64) -> Option<OfferEntry> {
        if !valid_offer_token(token) {
            return None;
        }
        let _g = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        let wanted = sha256_hex(token.as_bytes());
        let entries = self.load();
        let mut live: Vec<OfferEntry> = entries
            .iter()
            .filter(|e| e.expires_at > now)
            .cloned()
            .collect();
        let found = live
            .iter()
            .position(|e| ct_eq(e.sha256.as_bytes(), wanted.as_bytes()));
        let taken = found.map(|i| live.remove(i));
        if live.len() != entries.len() {
            if let Err(e) = self.save(&live) {
                tracing::error!("could not update the phone pairing codes: {e}");
                return None;
            }
        }
        taken
    }
}

pub fn valid_offer_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------------------------------------------------------------------------
// Rate limiting

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardRefusal {
    /// Too many failed authentications recently.
    Blocked,
    /// Too many connections per minute.
    RateLimited,
    /// Too many open connections in total.
    Busy,
}

struct PeerState {
    tokens: f64,
    last: Instant,
    failures: u32,
    blocked_until: Option<Instant>,
}

pub struct LanGuard {
    peers: Mutex<HashMap<IpAddr, PeerState>>,
    active: Arc<AtomicUsize>,
    pub max_active: usize,
    pub per_minute: u32,
    pub max_failures: u32,
    pub block_for: Duration,
}

impl Default for LanGuard {
    fn default() -> Self {
        Self {
            peers: Mutex::default(),
            active: Arc::default(),
            max_active: MAX_LAN_CONNECTIONS,
            per_minute: CONNECTS_PER_MINUTE,
            max_failures: MAX_AUTH_FAILURES,
            block_for: BLOCK_FOR,
        }
    }
}

/// Holds one of the [`MAX_LAN_CONNECTIONS`] slots until dropped.
pub struct ActiveSlot(Arc<AtomicUsize>);

impl Drop for ActiveSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl LanGuard {
    fn peers(&self) -> std::sync::MutexGuard<'_, HashMap<IpAddr, PeerState>> {
        self.peers.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }

    /// Decides whether a new TCP connection from `ip` may proceed to TLS.
    pub fn admit(&self, ip: IpAddr, now: Instant) -> Result<ActiveSlot, GuardRefusal> {
        let mut peers = self.peers();
        if peers.len() > 4096 {
            // Forget idle, unblocked addresses so the table can't grow without bound.
            peers.retain(|_, p| p.failures > 0 || p.blocked_until.is_some_and(|b| b > now));
        }
        let rate = f64::from(self.per_minute) / 60.0;
        let cap = f64::from(self.per_minute.max(1));
        let p = peers.entry(ip).or_insert(PeerState {
            tokens: cap,
            last: now,
            failures: 0,
            blocked_until: None,
        });
        if let Some(until) = p.blocked_until {
            if until > now {
                return Err(GuardRefusal::Blocked);
            }
            p.blocked_until = None;
            p.failures = 0;
        }
        p.tokens = (p.tokens + now.saturating_duration_since(p.last).as_secs_f64() * rate).min(cap);
        p.last = now;
        if p.tokens < 1.0 {
            return Err(GuardRefusal::RateLimited);
        }
        if self.active.load(Ordering::SeqCst) >= self.max_active {
            return Err(GuardRefusal::Busy);
        }
        p.tokens -= 1.0;
        self.active.fetch_add(1, Ordering::SeqCst);
        Ok(ActiveSlot(Arc::clone(&self.active)))
    }

    /// A failed authentication; returns true when this one blocked the address.
    pub fn record_failure(&self, ip: IpAddr, now: Instant) -> bool {
        let mut peers = self.peers();
        let p = peers.entry(ip).or_insert(PeerState {
            tokens: f64::from(self.per_minute),
            last: now,
            failures: 0,
            blocked_until: None,
        });
        p.failures += 1;
        if p.failures >= self.max_failures {
            p.blocked_until = Some(now + self.block_for);
            tracing::warn!(%ip, "blocked for {} s after {} failed phone authentications", self.block_for.as_secs(), p.failures);
            return true;
        }
        false
    }

    pub fn record_success(&self, ip: IpAddr) {
        if let Some(p) = self.peers().get_mut(&ip) {
            p.failures = 0;
        }
    }
}

// ---------------------------------------------------------------------------
// Addresses, the pairing link and its QR code

/// This computer's IPv4 addresses a phone on the same network could use:
/// private ranges first, then other non-loopback, non-link-local ones.
pub fn local_addresses() -> Vec<IpAddr> {
    let mut addrs: Vec<IpAddr> = if_addrs::get_if_addrs()
        .map(|list| {
            list.into_iter()
                .filter(|i| !i.is_loopback())
                .map(|i| i.ip())
                .filter(|ip| match ip {
                    IpAddr::V4(v4) => !v4.is_link_local() && !v4.is_unspecified(),
                    IpAddr::V6(_) => false,
                })
                .collect()
        })
        .unwrap_or_default();
    addrs.sort_by_key(|ip| match ip {
        IpAddr::V4(v4) if v4.is_private() => 0,
        _ => 1,
    });
    addrs.dedup();
    addrs.truncate(16);
    addrs
}

/// Everything the phone needs, as the link inside the QR code.
pub fn pairing_uri(
    host: IpAddr,
    port: u16,
    fingerprint: &str,
    token: &str,
    daemon_id: &str,
    name: &str,
) -> String {
    let host = match host {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    };
    // Names are cleaned to letters, digits and " ._-", so only spaces need escaping.
    let name = clean_name(name, 32, "RootCause PC").replace(' ', "%20");
    format!(
        "{PAIR_URI_PREFIX}v=1&h={host}&p={port}&fp={fingerprint}&t={token}&id={daemon_id}&n={name}"
    )
}

/// The QR code for `text` as rows of '1' (dark) and '0' (light), no quiet zone.
pub fn qr_rows(text: &str) -> Vec<String> {
    let Ok(code) = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M) else {
        return Vec::new();
    };
    let width = code.width();
    code.to_colors()
        .chunks(width)
        .map(|row| {
            row.iter()
                .map(|c| if *c == qrcode::Color::Dark { '1' } else { '0' })
                .collect()
        })
        .collect()
}

/// The QR code drawn with half-block characters for a terminal (dark on light).
pub fn qr_terminal(rows: &[String]) -> String {
    let w = rows.first().map_or(0, String::len);
    let quiet = 2;
    let dark = |r: isize, c: isize| -> bool {
        if r < 0 || c < 0 {
            return false;
        }
        rows.get(r as usize)
            .and_then(|row| row.as_bytes().get(c as usize))
            .is_some_and(|b| *b == b'1')
    };
    let mut out = String::new();
    let (h, w) = (rows.len() as isize, w as isize);
    let mut r = -quiet;
    while r < h + quiet {
        for c in -quiet..w + quiet {
            // Light background: a dark module prints as a space on a white cell.
            out.push(match (dark(r, c), dark(r + 1, c)) {
                (false, false) => '█',
                (true, false) => '▄',
                (false, true) => '▀',
                (true, true) => ' ',
            });
        }
        out.push('\n');
        r += 2;
    }
    out
}

/// Facts `edge-daemon lan pair` reads from the running daemon.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LanInfo {
    pub port: u16,
    pub fingerprint: String,
    pub daemon_id: String,
    pub name: String,
    pub addresses: Vec<IpAddr>,
}

// ---------------------------------------------------------------------------
// Everything the server needs

pub struct Offer {
    pub uri: String,
    pub host: IpAddr,
    pub port: u16,
    pub fingerprint: String,
    pub expires_at: u64,
    pub qr_rows: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OfferError {
    Disabled,
    NoAddress,
    UnknownHost,
    Io(String),
}

impl std::fmt::Display for OfferError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Disabled => write!(f, "phone access over the network is off on this PC; run `edge-daemon lan enable` and restart the daemon"),
            Self::NoAddress => write!(f, "this PC has no network address a phone could reach; connect it to the workshop Wi-Fi or network"),
            Self::UnknownHost => write!(f, "that address isn't one of this PC's network addresses"),
            Self::Io(e) => write!(f, "could not save the pairing code: {e}"),
        }
    }
}

pub struct LanState {
    pub settings: LanSettings,
    /// Present when the network listener is on.
    pub identity: Option<LanIdentity>,
    pub registry: Arc<DeviceRegistry>,
    pub offers: OfferStore,
    pub guard: LanGuard,
    /// Overrides interface detection (tests).
    pub addresses_override: Option<Vec<IpAddr>>,
}

impl LanState {
    /// Off, nothing stored (the default for tests and a daemon with no data dir).
    pub fn disabled() -> Self {
        Self {
            settings: LanSettings::disabled(),
            identity: None,
            registry: Arc::new(DeviceRegistry::in_memory()),
            offers: OfferStore::in_memory(),
            guard: LanGuard::default(),
            addresses_override: None,
        }
    }

    /// On, in memory, with a fresh certificate (tests).
    pub fn enabled_in_memory(port: u16) -> std::io::Result<Self> {
        let mut settings = LanSettings::disabled();
        settings.enabled = true;
        settings.port = port;
        Ok(Self {
            settings,
            identity: Some(LanIdentity::generate()?),
            ..Self::disabled()
        })
    }

    /// From the data directory. The certificate is created only when enabled.
    pub fn open(dir: &Path, settings: LanSettings) -> std::io::Result<Self> {
        let identity = if settings.enabled {
            Some(LanIdentity::load_or_create(dir)?)
        } else {
            None
        };
        Ok(Self {
            settings,
            identity,
            registry: Arc::new(DeviceRegistry::at(lan_dir(dir).join("devices.json"))),
            offers: OfferStore::at(offers_path(dir)),
            guard: LanGuard::default(),
            addresses_override: None,
        })
    }

    pub fn enabled(&self) -> bool {
        self.settings.enabled && self.identity.is_some()
    }

    /// Addresses to offer the phone, best first.
    pub fn addresses(&self) -> Vec<IpAddr> {
        if let Some(a) = &self.addresses_override {
            return a.clone();
        }
        if let Some(h) = self.settings.advertised_host {
            return vec![h];
        }
        match self.settings.bind {
            ip if !ip.is_unspecified() => vec![ip],
            _ => local_addresses(),
        }
    }

    pub fn info(&self) -> Option<LanInfo> {
        let id = self.identity.as_ref()?;
        Some(LanInfo {
            port: self.settings.port,
            fingerprint: id.fingerprint.clone(),
            daemon_id: id.daemon_id.clone(),
            name: self.settings.name.clone(),
            addresses: self.addresses(),
        })
    }

    /// A pairing QR code for `host` (or the best address).
    pub fn issue_offer(
        &self,
        host: Option<IpAddr>,
        paired_by: Option<String>,
        tenant_id: Option<String>,
        now: u64,
    ) -> Result<Offer, OfferError> {
        let info = self
            .info()
            .filter(|_| self.settings.enabled)
            .ok_or(OfferError::Disabled)?;
        offer_from_info(&info, &self.offers, host, paired_by, tenant_id, now)
    }
}

/// Shared by the daemon and `edge-daemon lan pair`.
pub fn offer_from_info(
    info: &LanInfo,
    offers: &OfferStore,
    host: Option<IpAddr>,
    paired_by: Option<String>,
    tenant_id: Option<String>,
    now: u64,
) -> Result<Offer, OfferError> {
    let host = match host {
        Some(h) if info.addresses.contains(&h) => h,
        Some(_) => return Err(OfferError::UnknownHost),
        None => *info.addresses.first().ok_or(OfferError::NoAddress)?,
    };
    let (token, expires_at) = offers
        .issue(now, paired_by, tenant_id)
        .map_err(|e| OfferError::Io(e.to_string()))?;
    let uri = pairing_uri(
        host,
        info.port,
        &info.fingerprint,
        &token,
        &info.daemon_id,
        &info.name,
    );
    Ok(Offer {
        qr_rows: qr_rows(&uri),
        uri,
        host,
        port: info.port,
        fingerprint: info.fingerprint.clone(),
        expires_at,
    })
}

/// The `Host` header of a network connection must name an IP literal or a
/// `.local` mDNS name with our port: no other DNS name can reach us, which
/// shuts out DNS rebinding through a browser on the network.
pub fn lan_host_ok(host: &str, port: u16) -> bool {
    let Some((name, p)) = host.rsplit_once(':') else {
        return false;
    };
    if p.parse::<u16>().ok() != Some(port) {
        return false;
    }
    if let Some(v6) = name.strip_prefix('[').and_then(|n| n.strip_suffix(']')) {
        return v6.parse::<std::net::Ipv6Addr>().is_ok();
    }
    if name.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    name.len() <= 70
        && name.ends_with(".local")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_default_off_and_env_overrides() {
        let none = |_: &str| None;
        let s = LanSettings::resolve(&LanConfigFile::default(), &none);
        assert!(!s.enabled, "off by default");
        assert_eq!(s.port, DEFAULT_LAN_PORT);
        assert!(!s.mdns);
        let file = LanConfigFile {
            enabled: true,
            mdns: true,
            port: Some(9000),
        };
        let s = LanSettings::resolve(&file, &none);
        assert!(s.enabled && s.mdns);
        assert_eq!(s.port, 9000);
        let env = |k: &str| match k {
            "EDGE_LAN" => Some("off".to_owned()),
            "EDGE_LAN_PORT" => Some("9100".to_owned()),
            "EDGE_LAN_HOST" => Some("10.1.2.3".to_owned()),
            "EDGE_LAN_NAME" => Some("Bay 3 <script>".to_owned()),
            _ => None,
        };
        let s = LanSettings::resolve(&file, &env);
        assert!(!s.enabled, "EDGE_LAN=off wins over the file");
        assert_eq!(s.port, 9100);
        assert_eq!(s.advertised_host, Some("10.1.2.3".parse().unwrap()));
        assert_eq!(s.name, "Bay 3 script");
    }

    #[test]
    fn identity_persists_and_rotates() {
        let dir = std::env::temp_dir().join(format!("edge-lan-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let a = LanIdentity::load_or_create(&dir).unwrap();
        assert_eq!(a.fingerprint.len(), 64);
        assert!(valid_daemon_id(&a.daemon_id));
        let b = LanIdentity::load_or_create(&dir).unwrap();
        assert_eq!(
            a.fingerprint, b.fingerprint,
            "same certificate after restart"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(lan_dir(&dir).join("key.der"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "private key is owner-only");
        }
        a.tls_config().expect("usable TLS config");
        LanIdentity::rotate(&dir).unwrap();
        let c = LanIdentity::load_or_create(&dir).unwrap();
        assert_ne!(
            a.fingerprint, c.fingerprint,
            "rotation makes a new certificate"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn registry_authenticates_revokes_and_binds_tenant() {
        let reg = Arc::new(DeviceRegistry::in_memory());
        let (id, secret) = reg.add("Pixel 8", Some("u1".into()), None, 100).unwrap();
        let cred = format!("{id}.{secret}");
        assert_eq!(reg.authenticate(&cred).unwrap().name, "Pixel 8");
        let mut wrong = secret.clone().into_bytes();
        wrong[0] = if wrong[0] == b'A' { b'B' } else { b'A' };
        let wrong = format!("{id}.{}", String::from_utf8(wrong).unwrap());
        assert!(reg.authenticate(&wrong).is_none());
        assert!(reg.authenticate("lan_0000.short").is_none());
        assert_eq!(
            reg.check_tenant(&id, "t1"),
            TenantCheck::Ok,
            "first use binds"
        );
        assert_eq!(reg.check_tenant(&id, "t1"), TenantCheck::Ok);
        assert_eq!(reg.check_tenant(&id, "t2"), TenantCheck::Mismatch);
        let mut rx = reg.subscribe();
        {
            let _g = reg.connected(&id);
            assert_eq!(reg.connected_count(&id), 1);
        }
        assert_eq!(reg.connected_count(&id), 0);
        assert!(reg.revoke(&id).unwrap());
        assert_eq!(rx.try_recv().unwrap(), id);
        assert!(
            reg.authenticate(&cred).is_none(),
            "revoked credential fails"
        );
        assert!(!reg.revoke(&id).unwrap());
        assert_eq!(reg.check_tenant(&id, "t1"), TenantCheck::Unknown);
    }

    #[test]
    fn registry_file_stores_only_hashes_and_reload_sees_cli_revocations() {
        let dir = std::env::temp_dir().join(format!("edge-lan-reg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("devices.json");
        let reg = DeviceRegistry::at(&path);
        let (id, secret) = reg.add("Phone", None, None, 1).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&secret), "secret never stored");
        // `edge-daemon lan revoke` edits the file from another process.
        DeviceRegistry::at(&path).revoke(&id).unwrap();
        let mut rx = reg.subscribe();
        assert_eq!(reg.reload(), vec![id.clone()]);
        assert_eq!(rx.try_recv().unwrap(), id);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn registry_caps_devices() {
        let reg = DeviceRegistry::in_memory();
        let (first, _) = reg.add("a", None, None, 0).unwrap();
        for i in 0..MAX_DEVICES {
            reg.add(&format!("p{i}"), None, None, 0).unwrap();
        }
        assert_eq!(reg.list().len(), MAX_DEVICES);
        assert!(reg.get(&first).is_none(), "oldest dropped");
    }

    #[test]
    fn offers_are_single_use_expire_and_are_capped() {
        let store = OfferStore::in_memory();
        let (t, exp) = store
            .issue(1_000, Some("u1".into()), Some("t1".into()))
            .unwrap();
        assert_eq!(exp, 1_000 + OFFER_TTL.as_secs());
        assert!(valid_offer_token(&t));
        let got = store.consume(&t, 1_010).unwrap();
        assert_eq!(got.tenant_id.as_deref(), Some("t1"));
        assert!(store.consume(&t, 1_011).is_none(), "single use");
        let (late, _) = store.issue(2_000, None, None).unwrap();
        assert!(
            store.consume(&late, 2_000 + OFFER_TTL.as_secs()).is_none(),
            "expired"
        );
        let first = store.issue(3_000, None, None).unwrap().0;
        for _ in 0..MAX_LIVE_OFFERS {
            store.issue(3_000, None, None).unwrap();
        }
        assert!(
            store.consume(&first, 3_001).is_none(),
            "oldest dropped past the cap"
        );
        assert!(store.consume("not-a-token", 3_001).is_none());
    }

    #[test]
    fn guard_rate_limits_blocks_and_caps() {
        let g = LanGuard {
            per_minute: 3,
            max_failures: 2,
            max_active: 2,
            ..LanGuard::default()
        };
        let ip: IpAddr = "192.168.1.50".parse().unwrap();
        let other: IpAddr = "192.168.1.51".parse().unwrap();
        let t0 = Instant::now();
        let a = g.admit(ip, t0).unwrap();
        let b = g.admit(ip, t0).unwrap();
        assert_eq!(g.admit(other, t0).err(), Some(GuardRefusal::Busy));
        drop(a);
        drop(b);
        assert_eq!(g.active(), 0);
        let _c = g.admit(ip, t0).unwrap();
        assert_eq!(g.admit(ip, t0).err(), Some(GuardRefusal::RateLimited));
        // Tokens refill at per_minute/60 per second.
        assert!(g.admit(ip, t0 + Duration::from_secs(21)).is_ok());
        assert!(!g.record_failure(other, t0));
        assert!(g.record_failure(other, t0));
        assert_eq!(g.admit(other, t0).err(), Some(GuardRefusal::Blocked));
        assert!(g
            .admit(other, t0 + BLOCK_FOR + Duration::from_secs(1))
            .is_ok());
    }

    #[test]
    fn host_header_rules() {
        assert!(lan_host_ok("192.168.1.20:8766", 8766));
        assert!(lan_host_ok("[fe80::1]:8766", 8766));
        assert!(lan_host_ok("rcd_0123456789abcdef.local:8766", 8766));
        assert!(!lan_host_ok("192.168.1.20:8765", 8766), "wrong port");
        assert!(
            !lan_host_ok("evil.example.com:8766", 8766),
            "DNS names refused"
        );
        assert!(!lan_host_ok("192.168.1.20", 8766));
    }

    #[test]
    fn pairing_link_and_qr() {
        let uri = pairing_uri(
            "192.168.1.20".parse().unwrap(),
            8766,
            &"ab".repeat(32),
            &"t".repeat(43),
            "rcd_0123456789abcdef",
            "Bay 3 PC",
        );
        assert!(uri.starts_with("rootcause://lan-pair?v=1&h=192.168.1.20&p=8766&fp=abab"));
        assert!(uri.ends_with("&id=rcd_0123456789abcdef&n=Bay%203%20PC"));
        let rows = qr_rows(&uri);
        assert!(rows.len() >= 21 && rows.iter().all(|r| r.len() == rows.len()));
        assert!(rows
            .iter()
            .all(|r| r.bytes().all(|b| b == b'0' || b == b'1')));
        assert!(qr_terminal(&rows).lines().count() >= rows.len() / 2);
    }

    #[test]
    fn offer_refuses_unknown_hosts_and_disabled() {
        let off = LanState::disabled();
        assert_eq!(
            off.issue_offer(None, None, None, 0).err(),
            Some(OfferError::Disabled)
        );
        let mut on = LanState::enabled_in_memory(8766).unwrap();
        on.addresses_override = Some(vec!["10.0.0.5".parse().unwrap()]);
        assert_eq!(
            on.issue_offer(Some("10.0.0.9".parse().unwrap()), None, None, 0)
                .err(),
            Some(OfferError::UnknownHost)
        );
        let offer = on.issue_offer(None, None, None, 0).unwrap();
        assert_eq!(offer.host, "10.0.0.5".parse::<IpAddr>().unwrap());
        assert!(offer.uri.contains(&offer.fingerprint));
        on.addresses_override = Some(vec![]);
        assert_eq!(
            on.issue_offer(None, None, None, 0).err(),
            Some(OfferError::NoAddress)
        );
    }
}
