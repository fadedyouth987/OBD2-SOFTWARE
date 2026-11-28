//! Secured local WebSocket server (Task 1.4, Rule 4).
//!
//! The socket can actuate a vehicle, so it is treated as privileged:
//!
//! - Binds 127.0.0.1 and [::1]. Phone access over the workshop network is a
//!   separate, opt-in TLS listener with paired-device credentials
//!   ([`super::lan`]); it is off unless `edge-daemon lan enable` turned it on.
//! - Upgrade refused (HTTP 403) unless `Host` is exactly `127.0.0.1:<port>`,
//!   `localhost:<port>` or `[::1]:<port>` (DNS-rebinding defence), and any
//!   browser `Origin` is in `EDGE_ALLOWED_ORIGINS`.
//! - The first message must be `HelloRequest` within 5 s; anything else gets
//!   `UNAUTHENTICATED` and the connection closes. The token is a single-use
//!   local pairing code or, for browsers, a cloud pairing JWT bound to the
//!   page's origin. Native clients (no `Origin`) need a local code.
//! - Protocol and policy versions are checked in Hello (A-ENG-3); an
//!   incompatible major gets `VERSION_UNSUPPORTED` with an update hint.
//! - 1 MiB message limit; 20 `DiagCommandRequest`/s per connection.
//! - Each connection gets its own `SafetyInterlock`; every diagnostic request
//!   goes through a `DiagChannel` (A-ENG-4).
//!
//! Connected adapters stream `CanFrameBatch` and `ObdPidStream` at 20 Hz. The
//! PID poll also feeds the interlock live speed, RPM and battery (Rule 5).
//! Virtual vehicles and physical adapters both stream; a physical bus is shared
//! between streaming and diagnostics through one bus lock.

use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicI64, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpListener,
    sync::{broadcast, mpsc},
    task::JoinHandle,
    time::Instant,
};
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::{header, StatusCode},
        protocol::WebSocketConfig,
        Message,
    },
};

use super::{
    lan::{self, LanState, TenantCheck},
    pairing::{looks_like_code, Consumed, PairingStore},
};
use crate::{
    analytics::{
        did_maps::{self, ModuleAddr},
        heuristics,
    },
    auth::{
        cloud_keys::KeyRing,
        lease::{self, ImmoLease, Lease},
        unix_now,
    },
    hal::{
        discovery,
        serial::SystemSerial,
        shared_bus::SharedBus,
        slcan_serial::SlcanSerialAdapter,
        stn_elm::{StnElmAdapter, StnProtocol},
        to_hex,
        virtual_bus::VirtualBus,
        HalError, VehicleBusAdapter,
    },
    immo::{self, ImmoRegistry},
    protocol::{
        self,
        messages::{
            self as m, AdapterKind, AdapterState, BusProtocol, EdgeMessage, ErrorCode, Feature,
            RequestId, SafetyMode,
        },
    },
    protocols::{
        addressing::CanAddressing,
        isotp::{IsoTpConfig, IsoTpLink},
        nrc_name,
        obd::Obd,
        DiagChannel, DiagError, DiagRequest, DiagTransport,
    },
    safety::{
        audit::AuditSink,
        interlock::{GatedRequest, RefusalCode, SafetyInterlock},
    },
    sim::profiles::{self, Link},
};

pub const DEFAULT_PORT: u16 = 8765;
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const DIAG_PER_SECOND: u32 = 20;
/// 20 Hz streaming.
pub const STREAM_PERIOD: Duration = Duration::from_millis(50);
/// PIDs polled every cycle for the live view and the interlock (max six per
/// request): RPM and speed (Rule 5 preconditions), MAF and the short-term trims.
const FAST_PIDS: [u8; 5] = [0x0C, 0x0D, 0x10, 0x06, 0x08];
/// Slow-moving PIDs, polled every `SLOW_EVERY` cycles: coolant and intake air
/// temperature, long-term trims (Task 4.1 scope: RPM, MAF, STFT/LTFT B1/B2, ECT, IAT).
const SLOW_PIDS: [u8; 4] = [0x05, 0x0F, 0x07, 0x09];
const SLOW_EVERY: u32 = 5;
/// PID samples kept for the live heuristics: about two minutes at 20 Hz.
const HEURISTIC_HISTORY: usize = 20 * 6 * 120;

pub struct ServerConfig {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub keys: KeyRing,
    /// Raw lease token; verified at every Hello so expiry takes effect.
    pub lease_token: Option<String>,
    /// Live lease token, updated when `lease.jwt` is replaced on disk.
    pub live_lease: Arc<Mutex<Option<String>>>,
    /// Bumped when the lease file or minimum generation changes so open sockets close.
    pub lease_epoch: Arc<AtomicU64>,
    /// Optional dongle / tablet identity; compared to the lease `rcid` claim.
    pub device_id: Option<String>,
    /// Leases with `lease_ver` below this are treated as revoked.
    pub lease_min_version: Arc<AtomicI64>,
    /// Optional immobilizer lease; verified at Hello and bound on Connect.
    pub immo_lease_token: Option<String>,
    /// Live immobilizer lease, replaced by `LeaseInstallRequest { kind: IMMO }`.
    pub live_immo_lease: Arc<Mutex<Option<String>>>,
    /// Where installed leases are saved; None keeps them in memory (tests).
    /// Native (code-paired) installs write `lease.jwt` / `immo_lease.jwt`;
    /// browser installs write `leases/<user>.jwt` / `immo_leases/<user>.jwt`.
    pub data_dir: Option<std::path::PathBuf>,
    /// Diagnostic leases installed by browser users, keyed by pairing user id.
    pub user_leases: Arc<Mutex<HashMap<String, String>>>,
    /// Immobilizer leases installed by browser users, keyed by pairing user id.
    pub user_immo_leases: Arc<Mutex<HashMap<String, String>>>,
    /// Per-user lease generation: replacing one user's lease only closes that
    /// user's other sockets.
    pub user_epochs: Arc<Mutex<HashMap<String, u64>>>,
    pub immo_registry: ImmoRegistry,
    pub pairing: Arc<PairingStore>,
    pub audit: Arc<dyn AuditSink>,
    pub hello_timeout: Duration,
    pub max_message_bytes: usize,
    pub diag_per_second: u32,
    pub stream_period: Duration,
    /// Phone access over the local network (off unless enabled).
    pub lan: Arc<LanState>,
}

impl ServerConfig {
    pub fn new(keys: KeyRing, pairing: Arc<PairingStore>, audit: Arc<dyn AuditSink>) -> Self {
        Self {
            port: DEFAULT_PORT,
            allowed_origins: vec!["http://localhost:3000".into()],
            keys,
            lease_token: None,
            live_lease: Arc::new(Mutex::new(None)),
            lease_epoch: Arc::new(AtomicU64::new(0)),
            device_id: None,
            lease_min_version: Arc::new(AtomicI64::new(0)),
            immo_lease_token: None,
            live_immo_lease: Arc::new(Mutex::new(None)),
            data_dir: None,
            user_leases: Arc::default(),
            user_immo_leases: Arc::default(),
            user_epochs: Arc::default(),
            immo_registry: ImmoRegistry::new(),
            pairing,
            audit,
            hello_timeout: HELLO_TIMEOUT,
            max_message_bytes: MAX_MESSAGE_BYTES,
            diag_per_second: DIAG_PER_SECOND,
            stream_period: STREAM_PERIOD,
            lan: Arc::new(LanState::disabled()),
        }
    }

    /// Loads per-user leases saved under `data_dir` (`leases/`, `immo_leases/`).
    pub fn load_user_leases(&self) {
        let Some(dir) = self.data_dir.as_ref() else {
            return;
        };
        for (sub, store) in [
            ("leases", &self.user_leases),
            ("immo_leases", &self.user_immo_leases),
        ] {
            let Ok(entries) = std::fs::read_dir(dir.join(sub)) else {
                continue;
            };
            let Ok(mut map) = store.lock() else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(user) = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_suffix(".jwt"))
                    .filter(|u| valid_user_id(u))
                else {
                    continue;
                };
                if let Ok(token) = std::fs::read_to_string(&path) {
                    map.insert(user.to_owned(), token.trim().to_owned());
                }
            }
        }
    }

    fn user_epoch(&self, user: Option<&str>) -> u64 {
        user.and_then(|u| self.user_epochs.lock().ok()?.get(u).copied())
            .unwrap_or(0)
    }

    fn bump_user_epoch(&self, user: &str) -> u64 {
        let Ok(mut map) = self.user_epochs.lock() else {
            return 0;
        };
        let epoch = map.entry(user.to_owned()).or_insert(0);
        *epoch += 1;
        *epoch
    }

    fn allowed_hosts(&self) -> [String; 3] {
        let p = self.port;
        [
            format!("127.0.0.1:{p}"),
            format!("localhost:{p}"),
            format!("[::1]:{p}"),
        ]
    }
}

pub struct Server {
    listeners: Vec<TcpListener>,
    /// The network (phone) listener and its TLS acceptor, when enabled.
    lan: Option<(TcpListener, TlsAcceptor)>,
    cfg: Arc<ServerConfig>,
}

impl Server {
    /// Binds loopback only. Port 0 picks a free port (tests).
    pub async fn bind(mut cfg: ServerConfig) -> std::io::Result<Self> {
        let v4 = TcpListener::bind(("127.0.0.1", cfg.port)).await?;
        cfg.port = v4.local_addr()?.port();
        let mut listeners = vec![v4];
        match TcpListener::bind(("::1", cfg.port)).await {
            Ok(v6) => listeners.push(v6),
            Err(e) => tracing::warn!("IPv6 loopback unavailable ({e}); serving 127.0.0.1 only"),
        }
        let lan = Self::bind_lan(&mut cfg).await?;
        Ok(Self {
            listeners,
            lan,
            cfg: Arc::new(cfg),
        })
    }

    /// The opt-in network listener: TLS only, never the loopback port.
    async fn bind_lan(
        cfg: &mut ServerConfig,
    ) -> std::io::Result<Option<(TcpListener, TlsAcceptor)>> {
        if !cfg.lan.enabled() {
            return Ok(None);
        }
        let settings = cfg.lan.settings.clone();
        if settings.port != 0 && settings.port == cfg.port {
            return Err(std::io::Error::other(
                "the phone (network) port must differ from the loopback port",
            ));
        }
        let identity = cfg
            .lan
            .identity
            .clone()
            .ok_or_else(|| std::io::Error::other("network certificate missing"))?;
        let tls = identity.tls_config().map_err(std::io::Error::other)?;
        let listener = TcpListener::bind((settings.bind, settings.port)).await?;
        let port = listener.local_addr()?.port();
        if port != settings.port {
            // Port 0 (tests): record the port picked.
            match Arc::get_mut(&mut cfg.lan) {
                Some(state) => state.settings.port = port,
                None => {
                    return Err(std::io::Error::other(
                        "phone port 0 needs an unshared LanState",
                    ))
                }
            }
        }
        tracing::info!(
            port,
            bind = %settings.bind,
            fingerprint = %identity.fingerprint,
            "phone access on: TLS listener on the local network"
        );
        Ok(Some((listener, TlsAcceptor::from(Arc::new(tls)))))
    }

    pub fn port(&self) -> u16 {
        self.cfg.port
    }

    /// The phone (network) port, when that listener is on.
    pub fn lan_port(&self) -> Option<u16> {
        self.lan.as_ref().map(|_| self.cfg.lan.settings.port)
    }

    /// Phone access state shared with the running server (registry, guard).
    pub fn lan_state(&self) -> Arc<LanState> {
        Arc::clone(&self.cfg.lan)
    }

    /// Signal open sessions that the lease has changed; they must reconnect.
    pub fn bump_lease_epoch(&self) {
        self.cfg.lease_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Serves until the task is dropped.
    pub async fn run(self) {
        let mut accept_loops = Vec::new();
        for listener in self.listeners {
            let cfg = Arc::clone(&self.cfg);
            accept_loops.push(tokio::spawn(async move {
                loop {
                    match listener.accept().await {
                        Ok((stream, peer)) => {
                            tracing::debug!(%peer, "connection");
                            tokio::spawn(handle(Arc::clone(&cfg), stream, Via::Loopback));
                        }
                        Err(e) => tracing::warn!("accept failed: {e}"),
                    }
                }
            }));
        }
        if let Some((listener, acceptor)) = self.lan {
            accept_loops.push(tokio::spawn(lan_accept_loop(
                Arc::clone(&self.cfg),
                listener,
                acceptor,
            )));
        }
        for l in accept_loops {
            let _ = l.await;
        }
    }
}

/// Lease files are readable only by the daemon's user where the OS supports it.
/// User ids come from cloud-signed pairing tokens; they also name lease files,
/// so only plain id characters are accepted.
fn valid_user_id(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn reject(why: &str) -> ErrorResponse {
    reject_with(why, StatusCode::FORBIDDEN)
}

fn reject_with(why: &str, status: StatusCode) -> ErrorResponse {
    let mut resp = ErrorResponse::new(Some(why.to_owned()));
    *resp.status_mut() = status;
    resp
}

/// Which listener a connection came in on.
#[derive(Clone, Copy, Debug)]
enum Via {
    Loopback,
    /// The phone listener, after TLS; the peer's address for rate limiting.
    Lan(std::net::IpAddr),
}

/// How a network connection identified itself in the upgrade request.
#[derive(Clone)]
enum LanAuth {
    /// A paired phone (`Authorization: Bearer <device_id>.<secret>`).
    Device(lan::DeviceRecord),
    /// A phone pairing now (`Authorization: RootCause-Pair <token>`); the
    /// token is burnt when its `LanPairRequest` arrives.
    Pair(String),
}

/// Accepts phone connections: rate limit, then TLS (5 s), then the same
/// WebSocket handling as loopback with the network rules on top.
async fn lan_accept_loop(cfg: Arc<ServerConfig>, listener: TcpListener, acceptor: TlsAcceptor) {
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("network accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let ip = peer.ip();
        let slot = match cfg.lan.guard.admit(ip, std::time::Instant::now()) {
            Ok(slot) => slot,
            Err(why) => {
                tracing::info!(%ip, ?why, "network connection refused");
                drop(stream);
                continue;
            }
        };
        let cfg = Arc::clone(&cfg);
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let _slot = slot;
            let _ = stream.set_nodelay(true);
            match tokio::time::timeout(lan::TLS_HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await {
                Ok(Ok(tls)) => handle(cfg, tls, Via::Lan(ip)).await,
                // A phone pinned to another certificate aborts here; nothing to count.
                Ok(Err(e)) => tracing::info!(%ip, "TLS handshake failed: {e}"),
                Err(_) => tracing::info!(%ip, "TLS handshake timed out"),
            }
        });
    }
}

/// Checks a network upgrade request: Host, Origin and the phone's credential.
#[allow(clippy::result_large_err)]
fn check_lan_upgrade(
    cfg: &ServerConfig,
    ip: std::net::IpAddr,
    req: &Request,
) -> Result<(String, LanAuth), ErrorResponse> {
    let header = |name| {
        req.headers()
            .get(name)
            .and_then(|v: &tokio_tungstenite::tungstenite::http::HeaderValue| v.to_str().ok())
            .unwrap_or("")
    };
    if !lan::lan_host_ok(header(header::HOST), cfg.lan.settings.port) {
        return Err(reject("host not allowed"));
    }
    let origin = header(header::ORIGIN);
    if origin.is_empty() || !cfg.allowed_origins.iter().any(|a| a == origin) {
        return Err(reject("origin not allowed"));
    }
    let auth = header(header::AUTHORIZATION);
    let found = if let Some(cred) = auth.strip_prefix("Bearer ") {
        cfg.lan
            .registry
            .authenticate(cred.trim())
            .map(LanAuth::Device)
    } else if let Some(token) = auth.strip_prefix("RootCause-Pair ") {
        let token = token.trim();
        lan::valid_offer_token(token).then(|| LanAuth::Pair(token.to_owned()))
    } else {
        None
    };
    match found {
        Some(a) => Ok((origin.to_owned(), a)),
        None => {
            cfg.lan.guard.record_failure(ip, std::time::Instant::now());
            Err(reject_with(
                "this phone isn't paired with this PC (or was removed); pair it again from Devices on the PC",
                StatusCode::UNAUTHORIZED,
            ))
        }
    }
}

/// Resolves when this connection's phone is revoked; never for other clients.
async fn revoked(
    rx: &mut Option<broadcast::Receiver<String>>,
    cfg: &ServerConfig,
    mine: Option<&str>,
) {
    let (Some(rx), Some(mine)) = (rx.as_mut(), mine) else {
        return std::future::pending().await;
    };
    loop {
        match rx.recv().await {
            Ok(id) if id == mine => return,
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => {
                if cfg.lan.registry.get(mine).is_none() {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Closed) => return std::future::pending().await,
        }
    }
}

enum Outbound {
    Msg(EdgeMessage),
    Close,
}

fn err(request_id: Option<RequestId>, code: ErrorCode, message: &str) -> EdgeMessage {
    protocol::error_response(request_id, code, message, None).into()
}

fn request_id_of(text: &str) -> Option<RequestId> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    value.get("request_id")?.as_str()?.try_into().ok()
}

fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64)
}

fn random_session_id() -> String {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("OS random source available");
    format!(
        "sess_{}",
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    )
}

// The handshake callback's error type is fixed by tungstenite.
#[allow(clippy::result_large_err)]
async fn handle<S>(cfg: Arc<ServerConfig>, stream: S, via: Via)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let origin_slot: Arc<Mutex<Option<String>>> = Arc::default();
    let lan_slot: Arc<Mutex<Option<LanAuth>>> = Arc::default();
    let slot = Arc::clone(&origin_slot);
    let lan_auth_slot = Arc::clone(&lan_slot);
    let check_cfg = Arc::clone(&cfg);
    let callback = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        if let Via::Lan(ip) = via {
            let (origin, auth) = check_lan_upgrade(&check_cfg, ip, req)?;
            *slot.lock().expect("origin lock") = Some(origin);
            *lan_auth_slot.lock().expect("lan lock") = Some(auth);
            return Ok(resp);
        }
        let host = req
            .headers()
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !check_cfg.allowed_hosts().iter().any(|h| h == host) {
            return Err(reject("host not allowed"));
        }
        if let Some(origin) = req.headers().get(header::ORIGIN) {
            let origin = origin.to_str().unwrap_or("");
            if !check_cfg.allowed_origins.iter().any(|a| a == origin) {
                return Err(reject("origin not allowed"));
            }
            *slot.lock().expect("origin lock") = Some(origin.to_owned());
        }
        Ok(resp)
    };
    let ws_cfg = WebSocketConfig::default()
        .max_message_size(Some(cfg.max_message_bytes))
        .max_frame_size(Some(cfg.max_message_bytes));
    let ws = match accept_hdr_async_with_config(stream, callback, Some(ws_cfg)).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::info!("WebSocket upgrade refused: {e}");
            return;
        }
    };
    let origin = origin_slot.lock().expect("origin lock").clone();
    let lan_auth = lan_slot.lock().expect("lan lock").clone();
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Outbound>(256);
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let result = match out {
                Outbound::Msg(msg) => sink.send(Message::text(protocol::to_wire(&msg))).await,
                Outbound::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if result.is_err() {
                break;
            }
        }
    });

    // A phone pairing now: one LanPairRequest, one answer, then close.
    if let (Via::Lan(ip), Some(LanAuth::Pair(token))) = (via, lan_auth.as_ref()) {
        let first = tokio::time::timeout(cfg.hello_timeout, next_text(&mut source)).await;
        if let Ok(Some(text)) = first {
            let reply = lan_pair(&cfg, ip, token, &text);
            let _ = tx.send(Outbound::Msg(reply)).await;
        }
        let _ = tx.send(Outbound::Close).await;
        drop(tx);
        let _ = writer.await;
        return;
    }
    let device = match lan_auth {
        Some(LanAuth::Device(d)) => Some(d),
        _ => None,
    };
    let mut revoked_rx = device.as_ref().map(|_| cfg.lan.registry.subscribe());
    let _connected = device.as_ref().map(|d| cfg.lan.registry.connected(&d.id));

    // Rule 4: nothing but HelloRequest until authenticated.
    let first = tokio::time::timeout(cfg.hello_timeout, next_text(&mut source)).await;
    let session = match first {
        Err(_) => Err(err(
            None,
            ErrorCode::Unauthenticated,
            "no HelloRequest within 5 s",
        )),
        Ok(None) => {
            drop(tx);
            let _ = writer.await;
            return;
        }
        Ok(Some(text)) => authenticate(&cfg, origin.as_deref(), &text, tx.clone(), device.as_ref()),
    };
    let mut session = match session {
        Ok((session, hello)) => {
            let _ = tx.send(Outbound::Msg(hello)).await;
            session
        }
        Err(refusal) => {
            let _ = tx.send(Outbound::Msg(refusal)).await;
            let _ = tx.send(Outbound::Close).await;
            drop(tx);
            let _ = writer.await;
            return;
        }
    };

    if let (Via::Lan(ip), Some(d)) = (via, device.as_ref()) {
        cfg.lan.guard.record_success(ip);
        cfg.lan.registry.touch(&d.id, unix_now());
    }
    let my_device = device.as_ref().map(|d| d.id.clone());
    let mut my_epoch = cfg.lease_epoch.load(Ordering::SeqCst);
    let mut my_user_epoch = cfg.user_epoch(session.user.as_deref());
    loop {
        let text = tokio::select! {
            t = next_text(&mut source) => match t {
                Some(t) => t,
                None => break,
            },
            () = revoked(&mut revoked_rx, &cfg, my_device.as_deref()) => {
                let _ = tx
                    .send(Outbound::Msg(err(
                        None,
                        ErrorCode::Unauthenticated,
                        "this phone was removed from the PC; pair it again from Devices on the PC",
                    )))
                    .await;
                let _ = tx.send(Outbound::Close).await;
                break;
            }
        };
        if cfg.lease_epoch.load(Ordering::SeqCst) != my_epoch
            || cfg.user_epoch(session.user.as_deref()) != my_user_epoch
        {
            let _ = tx
                .send(Outbound::Msg(err(
                    request_id_of(&text),
                    ErrorCode::TokenInvalid,
                    "lease changed; reconnect with a fresh lease",
                )))
                .await;
            let _ = tx.send(Outbound::Close).await;
            break;
        }
        let reply = session.handle(&text).await;
        if let Some(epoch) = session.adopted_epoch.take() {
            // This connection installed the new lease itself, so it stays open.
            my_epoch = epoch;
        }
        if let Some(epoch) = session.adopted_user_epoch.take() {
            my_user_epoch = epoch;
        }
        if tx.send(Outbound::Msg(reply)).await.is_err() {
            break;
        }
    }
    session.end();
    drop(session);
    drop(tx);
    let _ = writer.await;
}

/// Next text frame; `None` when the client closes or breaks a limit.
async fn next_text<S>(source: &mut S) -> Option<String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        match source.next().await? {
            Ok(Message::Text(t)) => return Some(t.as_str().to_owned()),
            Ok(Message::Binary(_)) => return Some(String::from("\u{0}binary")), // fails to parse
            Ok(Message::Close(_)) => return None,
            Ok(_) => continue, // ping/pong handled by tungstenite
            Err(e) => {
                tracing::info!("connection closed: {e}");
                return None;
            }
        }
    }
}

// Runs once per connection; the refusal is sent straight back, so boxing buys nothing.
#[allow(clippy::result_large_err)]
fn authenticate(
    cfg: &Arc<ServerConfig>,
    origin: Option<&str>,
    text: &str,
    tx: mpsc::Sender<Outbound>,
    device: Option<&lan::DeviceRecord>,
) -> Result<(Session, EdgeMessage), EdgeMessage> {
    let hello = match protocol::parse_message(text) {
        Ok(EdgeMessage::HelloRequest(h)) => h,
        _ => {
            return Err(err(
                request_id_of(text),
                ErrorCode::Unauthenticated,
                "the first message must be HelloRequest",
            ))
        }
    };
    let rid = Some(hello.request_id.clone());
    for (theirs, ours, what) in [
        (
            hello.protocol_version.as_str(),
            protocol::PROTOCOL_VERSION,
            "protocol",
        ),
        (
            hello.policy_version.as_str(),
            protocol::policy_version(),
            "safety policy",
        ),
    ] {
        if !protocol::versions_compatible(ours, theirs) {
            return Err(err(
                rid,
                ErrorCode::VersionUnsupported,
                &format!("app {what} version {theirs}; this daemon supports {ours}"),
            ));
        }
    }
    let now = unix_now();
    let token = hello.client_token.as_str();
    if device.is_some() && looks_like_code(token) {
        // A code works once from anywhere it can be typed; over the network
        // it would hand the machine lease to whoever guessed it.
        return Err(err(
            rid,
            ErrorCode::Unauthenticated,
            "phones sign in with a RootCause account; local pairing codes only work on this PC",
        ));
    }
    let mut tenant = None;
    let user = if looks_like_code(token) {
        match cfg.pairing.try_consume(token, now) {
            Consumed::Paired => {}
            Consumed::Refused => {
                return Err(err(
                    rid,
                    ErrorCode::Unauthenticated,
                    "pairing code is wrong, expired or already used",
                ))
            }
            Consumed::CancelledAll => {
                return Err(err(
                    rid,
                    ErrorCode::Unauthenticated,
                    "too many wrong pairing codes; every code was cancelled. Run `edge-daemon pair` for a new one",
                ))
            }
        }
        None
    } else if origin.is_none() {
        return Err(err(
            rid,
            ErrorCode::Unauthenticated,
            "native clients pair with a local code from `edge-daemon pair`",
        ));
    } else {
        match lease::verify_pairing(token, &cfg.keys, origin, now) {
            Ok(p) => {
                tenant = Some(p.tenant_id);
                Some(p.user_id)
            }
            Err(e) => {
                return Err(err(
                    rid,
                    ErrorCode::Unauthenticated,
                    &format!("pairing token rejected: {e}"),
                ))
            }
        }
    };
    if let (Some(d), Some(t)) = (device, tenant.as_deref()) {
        match cfg.lan.registry.check_tenant(&d.id, t) {
            TenantCheck::Ok => {}
            TenantCheck::Mismatch => {
                return Err(err(
                    rid,
                    ErrorCode::Unauthenticated,
                    "this phone is paired for another workshop; sign in to that workshop, or pair the phone again",
                ))
            }
            TenantCheck::Unknown => {
                return Err(err(
                    rid,
                    ErrorCode::Unauthenticated,
                    "this phone was removed from the PC; pair it again from Devices on the PC",
                ))
            }
        }
    }
    let (lease, immo_lease) = leases_for(cfg, user.as_deref(), now);
    let session_id = random_session_id();
    let interlock = Arc::new(SafetyInterlock::new(
        session_id.clone(),
        Arc::clone(&cfg.audit),
    ));
    interlock.set_immo_registry(cfg.immo_registry.clone());
    interlock.set_identity(user.clone(), None);
    interlock.set_client(device.map(|d| format!("lan:{} ({})", d.id, d.name)));
    let hello_resp = m::HelloResponse {
        daemon_version: env!("CARGO_PKG_VERSION")
            .try_into()
            .expect("crate version is semver"),
        features: lease.features.clone(),
        lease_tier: lease.tier,
        policy_version: protocol::policy_version()
            .try_into()
            .expect("policy version is semver"),
        protocol_version: protocol::PROTOCOL_VERSION
            .try_into()
            .expect("protocol version is semver"),
        request_id: hello.request_id,
        session_id: session_id
            .as_str()
            .try_into()
            .expect("session id within limits"),
        type_: m::HelloResponseType::HelloResponse,
    };
    match device {
        Some(d) => {
            tracing::info!(%session_id, tier = %lease.tier, device = %d.id, "phone authenticated")
        }
        None => tracing::info!(%session_id, tier = %lease.tier, "client authenticated"),
    }
    let session = Session {
        lease,
        immo_lease,
        interlock,
        conn: None,
        bucket: Bucket::new(cfg.diag_per_second),
        tx,
        stream_period: cfg.stream_period,
        cfg: Arc::clone(cfg),
        adopted_epoch: None,
        adopted_user_epoch: None,
        user,
        tenant,
        lan_device: device.map(|d| d.id.clone()),
    };
    Ok((session, hello_resp.into()))
}

fn rfc3339_at(secs: u64) -> Option<m::Rfc3339Utc> {
    m::Rfc3339Utc::try_from(crate::safety::rfc3339(UNIX_EPOCH + Duration::from_secs(secs)).as_str())
        .ok()
}

/// Phone access settings and paired phones.
fn lan_status_message(cfg: &ServerConfig, request_id: RequestId) -> EdgeMessage {
    let state = &cfg.lan;
    let on = state.enabled();
    let devices = state
        .registry
        .list()
        .into_iter()
        .filter_map(|d| {
            Some(m::LanDevice {
                connected: state.registry.connected_count(&d.id) > 0,
                device_id: d.id.as_str().try_into().ok()?,
                last_seen_at: d.last_seen_at.and_then(rfc3339_at),
                name: d.name.as_str().try_into().ok()?,
                paired_at: rfc3339_at(d.paired_at)?,
                paired_by: d.paired_by.as_deref().and_then(|p| p.try_into().ok()),
            })
        })
        .collect();
    let identity = state.identity.as_ref().filter(|_| on);
    m::LanStatus {
        addresses: if on {
            state
                .addresses()
                .iter()
                .filter_map(|a| a.to_string().as_str().try_into().ok())
                .collect()
        } else {
            Vec::new()
        },
        daemon_id: identity.and_then(|i| i.daemon_id.as_str().try_into().ok()),
        daemon_name: state
            .settings
            .name
            .as_str()
            .try_into()
            .unwrap_or_else(|_| "RootCause PC".try_into().expect("valid name")),
        devices,
        enabled: on,
        fingerprint: identity.and_then(|i| i.fingerprint.as_str().try_into().ok()),
        mdns: on && state.settings.mdns,
        port: std::num::NonZeroU16::new(state.settings.port)
            .unwrap_or(std::num::NonZeroU16::new(lan::DEFAULT_LAN_PORT).expect("non-zero")),
        request_id,
        type_: m::LanStatusType::LanStatus,
    }
    .into()
}

/// The one message of a pairing connection: burns the code, registers the
/// phone and hands it its credential.
fn lan_pair(cfg: &ServerConfig, ip: std::net::IpAddr, token: &str, text: &str) -> EdgeMessage {
    let req = match protocol::parse_message(text) {
        Ok(EdgeMessage::LanPairRequest(r)) => r,
        _ => {
            return err(
                request_id_of(text),
                ErrorCode::Unauthenticated,
                "a pairing connection's only message is LanPairRequest",
            )
        }
    };
    let rid = Some(req.request_id.clone());
    let now = unix_now();
    let Some(offer) = cfg.lan.offers.consume(token, now) else {
        cfg.lan.guard.record_failure(ip, std::time::Instant::now());
        return err(
            rid,
            ErrorCode::Unauthenticated,
            "that pairing code is wrong, expired or already used; make a new one on the PC",
        );
    };
    let Some(identity) = cfg.lan.identity.as_ref() else {
        return err(
            rid,
            ErrorCode::LanUnavailable,
            "phone access is off on this PC",
        );
    };
    let (id, secret) = match cfg.lan.registry.add(
        req.device_name.as_str(),
        offer.paired_by.clone(),
        offer.tenant_id.clone(),
        now,
    ) {
        Ok(x) => x,
        Err(e) => {
            tracing::error!("could not save the paired phone: {e}");
            return err(
                rid,
                ErrorCode::ProtocolError,
                "the PC could not save the pairing",
            );
        }
    };
    cfg.lan.guard.record_success(ip);
    tracing::info!(device = %id, %ip, name = %req.device_name.as_str(), "phone paired");
    let built = (|| -> Option<m::LanPairResponse> {
        Some(m::LanPairResponse {
            daemon_id: identity.daemon_id.as_str().try_into().ok()?,
            daemon_name: cfg.lan.settings.name.as_str().try_into().ok()?,
            device_id: id.as_str().try_into().ok()?,
            device_secret: secret.as_str().try_into().ok()?,
            request_id: req.request_id.clone(),
            type_: m::LanPairResponseType::LanPairResponse,
        })
    })();
    match built {
        Some(r) => r.into(),
        None => {
            let _ = cfg.lan.registry.revoke(&id);
            err(
                rid,
                ErrorCode::ProtocolError,
                "could not build the pairing answer",
            )
        }
    }
}

/// The leases a new connection runs under.
///
/// A browser session (paired with a cloud token for user U) uses U's own
/// installed lease. Failing that it may use the machine lease (`lease.jwt`,
/// `EDGE_LEASE`) only when that lease was issued to U or to no one in
/// particular (an operator-provisioned lease). A native, code-paired client
/// uses the machine lease. One technician's paid lease never carries over to
/// another technician on the same machine.
fn leases_for(cfg: &ServerConfig, user: Option<&str>, now: u64) -> (Lease, Option<ImmoLease>) {
    let machine = cfg
        .live_lease
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| cfg.lease_token.clone());
    let own = user.and_then(|u| cfg.user_leases.lock().ok()?.get(u).cloned());
    let token = match (user, own) {
        (Some(_), Some(own)) => Some(own),
        (Some(u), None) => machine.filter(|t| {
            lease::verify_lease(t.trim(), &cfg.keys, now)
                .is_ok_and(|l| l.user_id.as_deref().is_none_or(|owner| owner == u))
        }),
        (None, _) => machine,
    };
    let lease = lease::effective_lease_constrained(
        token.as_deref(),
        &cfg.keys,
        now,
        cfg.device_id.as_deref(),
        cfg.lease_min_version.load(Ordering::SeqCst),
    );
    let machine_immo = cfg
        .live_immo_lease
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .or_else(|| cfg.immo_lease_token.clone());
    let own_immo = user.and_then(|u| cfg.user_immo_leases.lock().ok()?.get(u).cloned());
    let candidates = match user {
        Some(_) => [own_immo, machine_immo],
        None => [machine_immo, None],
    };
    let immo_lease = candidates.into_iter().flatten().find_map(|token| {
        match lease::verify_immo_lease(&token, &cfg.keys, now) {
            // Key-learn leases always name their technician.
            Ok(immo) if user.is_none_or(|u| immo.user_id == u) => Some(immo),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("immo lease rejected ({e})");
                None
            }
        }
    });
    (lease, immo_lease)
}

/// Token bucket: `rate` requests per second, bursts up to `rate`.
struct Bucket {
    rate: f64,
    tokens: f64,
    last: Instant,
}

impl Bucket {
    fn new(rate: u32) -> Self {
        Self {
            rate: f64::from(rate),
            tokens: f64::from(rate),
            last: Instant::now(),
        }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + (now - self.last).as_secs_f64() * self.rate).min(self.rate);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
enum BusHandle {
    Virtual(VirtualBus),
    Physical(SharedBus),
}

impl BusHandle {
    fn bitrate(&self) -> u32 {
        match self {
            Self::Virtual(b) => b.bitrate(),
            Self::Physical(b) => b.bitrate(),
        }
    }
}

struct Connected {
    adapter_id: String,
    bus: BusHandle,
    bus_lock: Arc<tokio::sync::Mutex<()>>,
    tasks: Vec<JoinHandle<()>>,
    channels: HashMap<(u32, u32), DiagChannel>,
    /// Channel keys, least recently used first (see [`MAX_DIAG_CHANNELS`]).
    channel_lru: VecDeque<(u32, u32)>,
}

/// Diagnostic channels kept open per connection. Each one gets a copy of every
/// bus frame, so a module-discovery sweep (hundreds of addresses) must not
/// leave hundreds open: past this many, the least recently used is closed.
pub const MAX_DIAG_CHANNELS: usize = 32;

impl Connected {
    /// Marks `key` most recently used, closing the oldest channels past the cap.
    fn touch_channel(&mut self, key: (u32, u32)) {
        for old in lru_touch(&mut self.channel_lru, key, MAX_DIAG_CHANNELS) {
            self.channels.remove(&old);
        }
    }
}

/// Moves `key` to the most-recent end of `order` and returns the keys evicted
/// to keep at most `cap` (oldest first). `key` itself is never evicted.
fn lru_touch<K: PartialEq + Copy>(order: &mut VecDeque<K>, key: K, cap: usize) -> Vec<K> {
    order.retain(|k| *k != key);
    order.push_back(key);
    let mut evicted = Vec::new();
    while order.len() > cap.max(1) {
        if let Some(old) = order.pop_front() {
            evicted.push(old);
        }
    }
    evicted
}

impl Drop for Connected {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

struct Session {
    lease: Lease,
    immo_lease: Option<ImmoLease>,
    interlock: Arc<SafetyInterlock>,
    conn: Option<Connected>,
    bucket: Bucket,
    tx: mpsc::Sender<Outbound>,
    stream_period: Duration,
    cfg: Arc<ServerConfig>,
    /// Set when this connection installed a lease: it adopts the new epoch instead of closing.
    adopted_epoch: Option<u64>,
    /// Same, for the per-user epoch (browser installs).
    adopted_user_epoch: Option<u64>,
    /// Pairing user for browser sessions; None for native, code-paired clients.
    user: Option<String>,
    /// The pairing user's workshop.
    tenant: Option<String>,
    /// The paired phone, for connections over the network.
    lan_device: Option<String>,
}

/// A diagnostic channel on its own port of the virtual or shared physical bus.
async fn open_channel(
    bus: BusHandle,
    bitrate: u32,
    addr: CanAddressing,
    interlock: Arc<SafetyInterlock>,
    lock: Arc<tokio::sync::Mutex<()>>,
) -> Result<DiagChannel, HalError> {
    Ok(open_channel_unlocked(bus, bitrate, addr, interlock)
        .await?
        .with_bus_lock(lock))
}

async fn open_channel_unlocked(
    bus: BusHandle,
    bitrate: u32,
    addr: CanAddressing,
    interlock: Arc<SafetyInterlock>,
) -> Result<DiagChannel, HalError> {
    match bus {
        BusHandle::Virtual(b) => {
            let mut port = b.adapter();
            port.open(bitrate).await?;
            let link = IsoTpLink::new(port, addr, IsoTpConfig::default()).await?;
            Ok(DiagChannel::isotp(link, interlock))
        }
        BusHandle::Physical(b) => {
            let port = b.port();
            let link = IsoTpLink::new(port, addr, IsoTpConfig::default()).await?;
            Ok(DiagChannel::isotp(link, interlock))
        }
    }
}

fn stn_protocol_for(protocol: BusProtocol) -> StnProtocol {
    match protocol {
        BusProtocol::Auto => StnProtocol::Auto,
        BusProtocol::Iso1576511500 | BusProtocol::BmwDcan => StnProtocol::Can11_500,
        BusProtocol::Iso1576529500 => StnProtocol::Can29_500,
        BusProtocol::Iso1576511250 => StnProtocol::Can11_250,
        BusProtocol::Iso1576529250 => StnProtocol::Can29_250,
        BusProtocol::MsCan125 => StnProtocol::MsCan125,
        BusProtocol::Iso91412 => StnProtocol::Iso9141,
        BusProtocol::Iso142305baud => StnProtocol::Kwp5Baud,
        BusProtocol::Iso14230Fast => StnProtocol::KwpFast,
        BusProtocol::J1850Pwm => StnProtocol::J1850Pwm,
        BusProtocol::J1850Vpw => StnProtocol::J1850Vpw,
    }
}

fn bitrate_for(protocol: BusProtocol, profile_bitrate: u32) -> Option<u32> {
    Some(match protocol {
        BusProtocol::Auto => profile_bitrate,
        BusProtocol::Iso1576511500 | BusProtocol::Iso1576529500 | BusProtocol::BmwDcan => 500_000,
        BusProtocol::Iso1576511250 | BusProtocol::Iso1576529250 => 250_000,
        BusProtocol::MsCan125 => 125_000,
        _ => return None,
    })
}

fn refusal_code(code: RefusalCode) -> ErrorCode {
    match code {
        RefusalCode::SafetyBlocked => ErrorCode::SafetyBlocked,
        RefusalCode::TokenInvalid => ErrorCode::TokenInvalid,
        RefusalCode::PreconditionUnknown => ErrorCode::PreconditionUnknown,
    }
}

impl Session {
    fn end(&mut self) {
        self.conn = None;
        self.interlock.end_session();
    }

    async fn handle(&mut self, text: &str) -> EdgeMessage {
        let msg = match protocol::parse_message(text) {
            Ok(msg) => msg,
            Err(e) => {
                return err(
                    request_id_of(text),
                    ErrorCode::ProtocolError,
                    &e.to_string(),
                )
            }
        };
        match msg {
            EdgeMessage::HelloRequest(r) => err(
                Some(r.request_id),
                ErrorCode::ProtocolError,
                "already authenticated",
            ),
            EdgeMessage::AdapterListRequest(r) => self.adapter_list(r.request_id),
            EdgeMessage::ConnectRequest(r) => self.connect(r).await,
            EdgeMessage::DisconnectRequest(r) => self.disconnect(r),
            EdgeMessage::SafetyConfirmRequest(r) => self.confirm(r),
            EdgeMessage::DiagCommandRequest(r) => self.diag(r).await,
            EdgeMessage::LeaseStatusRequest(r) => self.lease_status(r.request_id),
            EdgeMessage::LeaseInstallRequest(r) => self.install_lease(r),
            EdgeMessage::LanStatusRequest(r) => self.lan_status(r.request_id),
            EdgeMessage::LanPairOfferRequest(r) => self.lan_offer(r),
            EdgeMessage::LanDeviceRevokeRequest(r) => self.lan_revoke(r),
            EdgeMessage::LanPairRequest(r) => err(
                Some(r.request_id),
                ErrorCode::ProtocolError,
                "LanPairRequest is only sent on a phone's pairing connection",
            ),
            _ => err(
                request_id_of(text),
                ErrorCode::ProtocolError,
                "that message type is sent by the daemon, not the app",
            ),
        }
    }

    /// Phone access is managed only from this PC, never from a phone.
    fn lan_manage_refusal(&self, request_id: &RequestId) -> Option<EdgeMessage> {
        self.lan_device.as_ref().map(|_| {
            err(
                Some(request_id.clone()),
                ErrorCode::LanUnavailable,
                "phones can't pair or remove phones; do that on the PC's Devices page",
            )
        })
    }

    fn lan_status(&self, request_id: RequestId) -> EdgeMessage {
        if let Some(refusal) = self.lan_manage_refusal(&request_id) {
            return refusal;
        }
        lan_status_message(&self.cfg, request_id)
    }

    fn lan_offer(&self, r: m::LanPairOfferRequest) -> EdgeMessage {
        if let Some(refusal) = self.lan_manage_refusal(&r.request_id) {
            return refusal;
        }
        let rid = Some(r.request_id.clone());
        let host = match r
            .host
            .as_ref()
            .map(|h| h.as_str().parse::<std::net::IpAddr>())
        {
            None => None,
            Some(Ok(ip)) => Some(ip),
            Some(Err(_)) => return err(rid, ErrorCode::ProtocolError, "host is not an IP address"),
        };
        let offer =
            match self
                .cfg
                .lan
                .issue_offer(host, self.user.clone(), self.tenant.clone(), unix_now())
            {
                Ok(o) => o,
                Err(e @ (lan::OfferError::Disabled | lan::OfferError::NoAddress)) => {
                    return err(rid, ErrorCode::LanUnavailable, &e.to_string())
                }
                Err(e) => return err(rid, ErrorCode::ProtocolError, &e.to_string()),
            };
        tracing::info!(host = %offer.host, by = ?self.user, "phone pairing code issued");
        let built = (|| -> Option<m::LanPairOffer> {
            Some(m::LanPairOffer {
                expires_at: rfc3339_at(offer.expires_at)?,
                fingerprint: offer.fingerprint.as_str().try_into().ok()?,
                host: offer.host.to_string().as_str().try_into().ok()?,
                pairing_uri: offer.uri.as_str().try_into().ok()?,
                port: std::num::NonZeroU16::new(offer.port)?,
                qr_rows: offer
                    .qr_rows
                    .iter()
                    .map(|r| r.as_str().try_into().ok())
                    .collect::<Option<Vec<_>>>()?,
                request_id: r.request_id.clone(),
                type_: m::LanPairOfferType::LanPairOffer,
            })
        })();
        match built {
            Some(o) => o.into(),
            None => err(
                rid,
                ErrorCode::ProtocolError,
                "could not build the pairing code",
            ),
        }
    }

    fn lan_revoke(&self, r: m::LanDeviceRevokeRequest) -> EdgeMessage {
        if let Some(refusal) = self.lan_manage_refusal(&r.request_id) {
            return refusal;
        }
        let rid = Some(r.request_id.clone());
        let id = r.device_id.as_str();
        let Some(device) = self.cfg.lan.registry.get(id) else {
            return err(rid, ErrorCode::ProtocolError, "no paired phone has that id");
        };
        // A browser user may remove phones of their own workshop (or not yet
        // bound to one); a code-paired client at this PC may remove any.
        let allowed = self.user.is_none()
            || device.tenant_id.is_none()
            || device.tenant_id.as_deref() == self.tenant.as_deref();
        if !allowed {
            return err(
                rid,
                ErrorCode::Unauthenticated,
                "that phone belongs to another workshop",
            );
        }
        if let Err(e) = self.cfg.lan.registry.revoke(id) {
            return err(
                rid,
                ErrorCode::ProtocolError,
                &format!("could not remove the phone: {e}"),
            );
        }
        lan_status_message(&self.cfg, r.request_id)
    }

    fn lease_status(&self, request_id: RequestId) -> EdgeMessage {
        let at = |secs: u64| {
            m::Rfc3339Utc::try_from(
                crate::safety::rfc3339(UNIX_EPOCH + Duration::from_secs(secs)).as_str(),
            )
            .ok()
        };
        m::LeaseStatus {
            cloud_keys_pinned: !self.cfg.keys.is_empty(),
            expires_at: self.lease.expires_at.and_then(at),
            features: self.lease.features.clone(),
            immo_expires_at: self.immo_lease.as_ref().and_then(|l| at(l.expires_at)),
            lease_tier: self.lease.tier,
            request_id,
            type_: m::LeaseStatusType::LeaseStatus,
        }
        .into()
    }

    /// Verifies a cloud-signed lease, saves it, and switches this connection to it.
    /// Other open connections are asked to reconnect (lease epoch bump).
    fn install_lease(&mut self, r: m::LeaseInstallRequest) -> EdgeMessage {
        let rid = Some(r.request_id.clone());
        let token = r.lease_token.as_str().trim().to_owned();
        let now = unix_now();
        if self.cfg.keys.is_empty() {
            return err(
                rid,
                ErrorCode::LeaseRequired,
                "this daemon has no cloud signing key pinned, so it cannot accept cloud leases",
            );
        }
        match r.kind {
            m::LeaseKind::Diagnostic => {
                let lease = match lease::verify_lease(&token, &self.cfg.keys, now) {
                    Ok(l) => l,
                    Err(e) => {
                        return err(
                            rid,
                            ErrorCode::TokenInvalid,
                            &format!("lease rejected: {e}"),
                        )
                    }
                };
                if lease.immo {
                    return err(
                        rid,
                        ErrorCode::TokenInvalid,
                        "that is an immobilizer lease; install it with kind IMMO",
                    );
                }
                let constrained = lease::constrain_lease(
                    lease.clone(),
                    self.cfg.device_id.as_deref(),
                    self.cfg.lease_min_version.load(Ordering::SeqCst),
                );
                if constrained != lease {
                    return err(
                        rid,
                        ErrorCode::TokenInvalid,
                        "lease is for another device or has been superseded; fetch a new one",
                    );
                }
                if let Some(user) = self.user.clone() {
                    if let Some(refusal) =
                        self.check_owner(rid.clone(), &user, lease.user_id.as_deref())
                    {
                        return refusal;
                    }
                    let Ok(mut map) = self.cfg.user_leases.lock() else {
                        return err(rid, ErrorCode::AdapterError, "lease store unavailable");
                    };
                    if let Err(e) = self.save(&format!("leases/{user}.jwt"), &token) {
                        return err(rid, ErrorCode::AdapterError, &e);
                    }
                    map.insert(user.clone(), token);
                    drop(map);
                    self.adopted_user_epoch = Some(self.cfg.bump_user_epoch(&user));
                } else {
                    {
                        let Ok(mut live) = self.cfg.live_lease.lock() else {
                            return err(rid, ErrorCode::AdapterError, "lease store unavailable");
                        };
                        if let Err(e) = self.save("lease.jwt", &token) {
                            return err(rid, ErrorCode::AdapterError, &e);
                        }
                        *live = Some(token);
                    }
                    let epoch = self.cfg.lease_epoch.fetch_add(1, Ordering::SeqCst) + 1;
                    self.adopted_epoch = Some(epoch);
                }
                tracing::info!(tier = %constrained.tier, "diagnostic lease installed");
                self.lease = constrained;
            }
            m::LeaseKind::Immo => {
                if self.conn.is_some() {
                    return err(
                        rid,
                        ErrorCode::AdapterError,
                        "disconnect the vehicle, install the key-learn lease, then reconnect",
                    );
                }
                let immo = match lease::verify_immo_lease(&token, &self.cfg.keys, now) {
                    Ok(l) => l,
                    Err(e) => {
                        return err(
                            rid,
                            ErrorCode::TokenInvalid,
                            &format!("immobilizer lease rejected: {e}"),
                        )
                    }
                };
                if let Some(user) = self.user.clone() {
                    if let Some(refusal) = self.check_owner(rid.clone(), &user, Some(&immo.user_id))
                    {
                        return refusal;
                    }
                    let Ok(mut map) = self.cfg.user_immo_leases.lock() else {
                        return err(rid, ErrorCode::AdapterError, "lease store unavailable");
                    };
                    if let Err(e) = self.save(&format!("immo_leases/{user}.jwt"), &token) {
                        return err(rid, ErrorCode::AdapterError, &e);
                    }
                    map.insert(user, token);
                } else {
                    let Ok(mut live) = self.cfg.live_immo_lease.lock() else {
                        return err(rid, ErrorCode::AdapterError, "lease store unavailable");
                    };
                    if let Err(e) = self.save("immo_lease.jwt", &token) {
                        return err(rid, ErrorCode::AdapterError, &e);
                    }
                    *live = Some(token);
                }
                tracing::info!(session = %immo.session_id, "immobilizer lease installed");
                self.immo_lease = Some(immo);
            }
        }
        self.lease_status(r.request_id)
    }

    /// A browser session may only install a lease the cloud issued to its own user.
    fn check_owner(
        &self,
        rid: Option<RequestId>,
        user: &str,
        lease_user: Option<&str>,
    ) -> Option<EdgeMessage> {
        if !valid_user_id(user) {
            return Some(err(
                rid,
                ErrorCode::TokenInvalid,
                "pairing user id is not usable",
            ));
        }
        if lease_user != Some(user) {
            return Some(err(
                rid,
                ErrorCode::TokenInvalid,
                "that lease was issued to a different user; sign in as yourself and fetch your own",
            ));
        }
        None
    }

    /// Atomically writes a lease file under the data directory (no-op without one).
    fn save(&self, name: &str, token: &str) -> Result<(), String> {
        let Some(dir) = self.cfg.data_dir.as_ref() else {
            return Ok(());
        };
        crate::fsutil::write_atomic(&dir.join(name), token.as_bytes(), 0o600)
            .map_err(|e| format!("could not save {name}: {e}"))
    }

    fn adapter_list(&self, request_id: RequestId) -> EdgeMessage {
        let clip = |s: &str, n: usize| s.chars().take(n).collect::<String>();
        let adapters = discovery::discover()
            .into_iter()
            .filter_map(|a| {
                Some(m::AdapterInfo {
                    adapter_id: clip(&a.adapter_id, 128).as_str().try_into().ok()?,
                    display_name: clip(&a.display_name, 128).as_str().try_into().ok()?,
                    kind: a.kind,
                    path: a.path.and_then(|p| clip(&p, 512).as_str().try_into().ok()),
                })
            })
            .collect();
        m::AdapterListResponse {
            adapters,
            request_id,
            type_: m::AdapterListResponseType::AdapterListResponse,
        }
        .into()
    }

    fn status(
        &self,
        request_id: Option<RequestId>,
        adapter_id: &str,
        state: AdapterState,
        battery_v: Option<f64>,
    ) -> EdgeMessage {
        m::AdapterStatus {
            adapter_id: adapter_id
                .try_into()
                .expect("adapter id was validated on input"),
            battery_v,
            request_id,
            state,
            type_: m::AdapterStatusType::AdapterStatus,
        }
        .into()
    }

    async fn connect(&mut self, r: m::ConnectRequest) -> EdgeMessage {
        let rid = Some(r.request_id.clone());
        if self.conn.is_some() {
            return err(
                rid,
                ErrorCode::AdapterError,
                "already connected; send DisconnectRequest first",
            );
        }
        if r.safety_mode == SafetyMode::ActiveConfirmed && !self.lease.has(Feature::UdsActive) {
            return err(
                rid,
                ErrorCode::LeaseRequired,
                "ACTIVE_CONFIRMED needs the UDS_ACTIVE feature",
            );
        }
        let adapter_id = r.adapter_id.as_str();
        let Some(profile) = adapter_id
            .strip_prefix("virtual-")
            .and_then(profiles::by_id)
        else {
            let found = discovery::discover()
                .into_iter()
                .find(|a| a.adapter_id == adapter_id);
            let Some(adapter_info) = found else {
                return err(
                    rid,
                    ErrorCode::AdapterError,
                    &format!("unknown adapter {adapter_id}"),
                );
            };
            if adapter_info.kind == AdapterKind::J2534 && !self.lease.has(Feature::J2534) {
                return err(
                    rid,
                    ErrorCode::LeaseRequired,
                    "J2534 adapters need the J2534 feature",
                );
            }
            let path = adapter_info.path.clone().unwrap_or_default();
            let bitrate = r
                .baud_rate
                .map(|b| b.get())
                .or_else(|| bitrate_for(r.protocol, 500_000))
                .unwrap_or(500_000);
            let boxed: Box<dyn VehicleBusAdapter> = match adapter_info.kind {
                AdapterKind::StnElm => {
                    let link = match SystemSerial::open(&path, 115_200) {
                        Ok(l) => l,
                        Err(e) => return err(rid, ErrorCode::AdapterError, &e.to_string()),
                    };
                    Box::new(StnElmAdapter::new(link, stn_protocol_for(r.protocol)))
                }
                AdapterKind::Slcan => {
                    let link = match SystemSerial::open(&path, 115_200) {
                        Ok(l) => l,
                        Err(e) => return err(rid, ErrorCode::AdapterError, &e.to_string()),
                    };
                    Box::new(SlcanSerialAdapter::new(link))
                }
                #[cfg(target_os = "linux")]
                AdapterKind::Socketcan => {
                    Box::new(crate::hal::socketcan_linux::SocketCanAdapter::new(&path))
                }
                #[cfg(not(target_os = "linux"))]
                AdapterKind::Socketcan => {
                    return err(
                        rid,
                        ErrorCode::AdapterError,
                        "SocketCAN is only available on Linux",
                    );
                }
                AdapterKind::J2534 => {
                    #[cfg(windows)]
                    {
                        Box::new(crate::hal::j2534_win::J2534Adapter::new(
                            crate::hal::j2534_win::default_bridge_path(),
                            &path,
                        ))
                    }
                    #[cfg(not(windows))]
                    {
                        return err(
                            rid,
                            ErrorCode::AdapterError,
                            "J2534 PassThru requires Windows",
                        );
                    }
                }
                AdapterKind::KlineFtdi => {
                    return err(
                        rid,
                        ErrorCode::AdapterError,
                        "K-line FTDI direct streaming is not CAN",
                    );
                }
                AdapterKind::Virtual => unreachable!("handled by virtual- prefix"),
            };
            let shared = match SharedBus::open(boxed, bitrate).await {
                Ok(s) => s,
                Err(e) => return err(rid, ErrorCode::AdapterError, &e.to_string()),
            };
            let bus = BusHandle::Physical(shared.clone());
            let bus_lock = Arc::new(tokio::sync::Mutex::new(()));
            let mut tasks = vec![tokio::spawn(stream_can(
                shared.port(),
                self.tx.clone(),
                self.stream_period,
                self.lease.has(Feature::CanRePro),
            ))];
            match open_channel(
                bus.clone(),
                bitrate,
                CanAddressing::obd_functional(0x7E8),
                Arc::clone(&self.interlock),
                Arc::clone(&bus_lock),
            )
            .await
            {
                Ok(ch) => tasks.push(tokio::spawn(stream_pids(
                    ch,
                    Arc::clone(&self.interlock),
                    self.tx.clone(),
                    self.stream_period,
                ))),
                Err(e) => tracing::warn!("no OBD poller on physical adapter: {e}"),
            }
            // No identifier map for an unidentified real vehicle yet: say so (Rule 6).
            tasks.push(tokio::spawn(run_audit(
                bus.clone(),
                bitrate,
                None,
                Arc::clone(&self.interlock),
                Arc::clone(&bus_lock),
                self.tx.clone(),
            )));
            self.interlock.set_mode(r.safety_mode);
            self.conn = Some(Connected {
                adapter_id: adapter_id.to_owned(),
                bus,
                bus_lock,
                tasks,
                channels: HashMap::new(),
                channel_lru: VecDeque::new(),
            });
            return self.status(rid, adapter_id, AdapterState::Connected, None);
        };
        let Link::Can {
            bitrate: profile_bitrate,
        } = profile.link
        else {
            return err(
                rid,
                ErrorCode::AdapterError,
                "live view of K-line vehicles isn't available over the local connection yet; use a CAN vehicle",
            );
        };
        let requested = r
            .baud_rate
            .map(|b| b.get())
            .or_else(|| bitrate_for(r.protocol, profile_bitrate));
        let Some(bitrate) = requested else {
            return err(
                rid,
                ErrorCode::ProtocolError,
                &format!("{} is not a CAN protocol for this vehicle", r.protocol),
            );
        };
        let profile = crate::sim::faults::Faults::from_env().apply(profile);
        let profile_id = profile.id;
        let bus = match VirtualBus::new(profile) {
            Ok(bus) => bus,
            Err(e) => return err(rid, ErrorCode::AdapterError, &e.to_string()),
        };
        let mut frames = bus.adapter();
        if let Err(e) = frames.open(bitrate).await {
            return err(rid, ErrorCode::AdapterError, &e.to_string());
        }
        let bus_handle = BusHandle::Virtual(bus.clone());
        let bus_lock = Arc::new(tokio::sync::Mutex::new(()));
        let mut tasks = vec![tokio::spawn(stream_can(
            frames,
            self.tx.clone(),
            self.stream_period,
            self.lease.has(Feature::CanRePro),
        ))];
        match open_channel(
            bus_handle.clone(),
            bitrate,
            CanAddressing::obd_functional(0x7E8),
            Arc::clone(&self.interlock),
            Arc::clone(&bus_lock),
        )
        .await
        {
            Ok(ch) => tasks.push(tokio::spawn(stream_pids(
                ch,
                Arc::clone(&self.interlock),
                self.tx.clone(),
                self.stream_period,
            ))),
            Err(e) => tracing::warn!("no OBD poller: {e}"),
        }
        tasks.push(tokio::spawn(run_audit(
            bus_handle.clone(),
            bitrate,
            Some(profile_id),
            Arc::clone(&self.interlock),
            Arc::clone(&bus_lock),
            self.tx.clone(),
        )));
        self.interlock.set_mode(r.safety_mode);
        // The adapter measures battery voltage itself; speed and RPM count only
        // once the PID poll has read them from the bus (Rule 5), so a vehicle
        // that doesn't report them stays unknown and gated requests are refused.
        let battery = bus.with_vehicle(|v| v.battery_v);
        let vin = bus.with_vehicle(|v| v.vin.clone());
        self.interlock.update_battery(battery);
        // Keep the technician: the audit log names who did it as well as the car.
        self.interlock
            .set_identity(self.user.clone(), Some(vin.clone()));
        if let Some(immo) = self.immo_lease.clone() {
            if let Err(refusal) =
                self.interlock
                    .begin_immo(immo, &vin, immo::canonical_device_id(adapter_id))
            {
                for t in &tasks {
                    t.abort();
                }
                return err(rid, refusal_code(refusal.code), &refusal.message);
            }
        }
        self.conn = Some(Connected {
            adapter_id: adapter_id.to_owned(),
            bus: bus_handle,
            bus_lock,
            tasks,
            channels: HashMap::new(),
            channel_lru: VecDeque::new(),
        });
        self.status(rid, adapter_id, AdapterState::Connected, Some(battery))
    }

    fn disconnect(&mut self, r: m::DisconnectRequest) -> EdgeMessage {
        let rid = Some(r.request_id.clone());
        match self.conn.take() {
            Some(conn) if conn.adapter_id == r.adapter_id.as_str() => {
                drop(conn);
                self.interlock.end_session();
                self.status(rid, r.adapter_id.as_str(), AdapterState::Disconnected, None)
            }
            other => {
                self.conn = other;
                err(
                    rid,
                    ErrorCode::AdapterError,
                    "that adapter is not connected",
                )
            }
        }
    }

    fn confirm(&self, r: m::SafetyConfirmRequest) -> EdgeMessage {
        let rid = Some(r.request_id.clone());
        let Ok(payload) = crate::hal::parse_hex(&r.payload_hex) else {
            return err(rid, ErrorCode::ProtocolError, "payload_hex is not hex");
        };
        if payload.first() != Some(&r.service_id.0) {
            return err(
                rid,
                ErrorCode::ProtocolError,
                "service_id must equal the first payload byte",
            );
        }
        let req = GatedRequest {
            protocol: r.protocol,
            tx: r.tx_id.0,
            rx: r.rx_id.0,
            payload: &payload,
        };
        match self.interlock.issue_token(&req, &r.user_ack_text) {
            Ok(grant) => m::SafetyConfirmResponse {
                expires_at: grant.expires_at.as_str().try_into().expect("RFC 3339 UTC"),
                preconditions: m::Preconditions {
                    battery_v: grant.preconditions.battery_v,
                    rpm: grant.preconditions.rpm,
                    speed_age_ms: grant.preconditions.speed_age.map(|a| a.as_millis() as u64),
                    speed_kmh: grant.preconditions.speed_kmh,
                },
                request_id: r.request_id,
                safety_token: grant
                    .token
                    .as_str()
                    .try_into()
                    .expect("token within limits"),
                type_: m::SafetyConfirmResponseType::SafetyConfirmResponse,
            }
            .into(),
            Err(refusal) => {
                let detail = refusal.retry_after.map(|d| {
                    let mut map = serde_json::Map::new();
                    map.insert("retry_after_ms".into(), (d.as_millis() as u64).into());
                    map
                });
                protocol::error_response(rid, refusal_code(refusal.code), &refusal.message, detail)
                    .into()
            }
        }
    }

    async fn diag(&mut self, r: m::DiagCommandRequest) -> EdgeMessage {
        let rid = Some(r.request_id.clone());
        if !self.bucket.take() {
            return err(
                rid,
                ErrorCode::ProtocolError,
                "rate limit: at most 20 DiagCommandRequest per second",
            );
        }
        let Ok(payload) = crate::hal::parse_hex(&r.payload_hex) else {
            return err(rid, ErrorCode::ProtocolError, "payload_hex is not hex");
        };
        if payload.first() != Some(&r.service_id.0) {
            return err(
                rid,
                ErrorCode::ProtocolError,
                "service_id must equal the first payload byte",
            );
        }
        let Some(conn) = self.conn.as_ref() else {
            return err(rid, ErrorCode::AdapterError, "connect an adapter first");
        };
        let key = (r.tx_id.0, r.rx_id.0);
        if !conn.channels.contains_key(&key) {
            let (bus, bitrate, lock) = (
                conn.bus.clone(),
                conn.bus.bitrate(),
                Arc::clone(&conn.bus_lock),
            );
            // Local box fix: r.protocol is DiagProtocol, not BusProtocol.
            // BMW D-CAN extended addressing is detected from IDs (0x6F1 / 0x6xx).
            let addressing = if key.0 == 0x6F1 && (0x600..=0x6FF).contains(&key.1) {
                CanAddressing::BmwExtended {
                    ecu: (key.1 & 0xFF) as u8,
                }
            } else {
                CanAddressing::normal(key.0, key.1)
            };
            match open_channel(bus, bitrate, addressing, Arc::clone(&self.interlock), lock).await {
                Ok(ch) => {
                    self.conn
                        .as_mut()
                        .expect("checked above")
                        .channels
                        .insert(key, ch);
                }
                Err(e) => return err(rid, ErrorCode::AdapterError, &e.to_string()),
            }
        }
        let conn = self.conn.as_mut().expect("checked above");
        conn.touch_channel(key);
        let ch = conn.channels.get_mut(&key).expect("inserted above");
        let token = r.safety_token.as_ref().map(|t| t.as_str());
        let result = ch
            .request(DiagRequest {
                protocol: r.protocol,
                payload: &payload,
                safety_token: token,
            })
            .await;
        match result {
            Ok(resp) => {
                let negative = resp.first() == Some(&0x7F);
                let nrc = negative
                    .then(|| resp.get(2).copied())
                    .flatten()
                    .map(|code| m::Nrc {
                        code,
                        name: nrc_name(code).try_into().expect("NRC names within limits"),
                    });
                m::DiagCommandResponse {
                    nrc,
                    positive: !negative,
                    request_id: r.request_id,
                    response_hex: to_hex(&resp).as_str().try_into().expect("hex"),
                    type_: m::DiagCommandResponseType::DiagCommandResponse,
                }
                .into()
            }
            Err(DiagError::Refused(refusal)) => {
                err(rid, refusal_code(refusal.code), &refusal.message)
            }
            Err(DiagError::Hal(HalError::Timeout(_))) => {
                err(rid, ErrorCode::Timeout, "no reply from the ECU")
            }
            Err(DiagError::Hal(e)) => err(rid, ErrorCode::AdapterError, &e.to_string()),
            Err(e) => err(rid, ErrorCode::ProtocolError, &e.to_string()),
        }
    }
}

/// Cross-module audit (Task 1.3) once per connect: VIN and odometer from every
/// mapped module, distance since codes cleared and readiness monitors. Pushes
/// each `HeuristicAlert`. A clean result is reported as `audit.consistent` only
/// when every mapped identifier was actually read; otherwise `audit.incomplete`
/// names the modules that did not answer (Rule 6: never a pass for an unverified check).
async fn run_audit(
    bus: BusHandle,
    bitrate: u32,
    profile_id: Option<&'static str>,
    interlock: Arc<SafetyInterlock>,
    lock: Arc<tokio::sync::Mutex<()>>,
    tx: mpsc::Sender<Outbound>,
) {
    let alerts = audit_alerts(bus, bitrate, profile_id, interlock, lock).await;
    for a in alerts {
        if tx.send(Outbound::Msg(a.into())).await.is_err() {
            return;
        }
    }
}

async fn audit_alerts(
    bus: BusHandle,
    bitrate: u32,
    profile_id: Option<&'static str>,
    interlock: Arc<SafetyInterlock>,
    lock: Arc<tokio::sync::Mutex<()>>,
) -> Vec<m::HeuristicAlert> {
    use serde_json::json;
    let map = profile_id.and_then(did_maps::for_profile);
    let Some(map) = map else {
        return heuristics::cross_module_audit(&heuristics::audit_input(
            None,
            Vec::new(),
            (None, None),
        ));
    };
    let mut readings = Vec::new();
    let mut silent = Vec::new();
    for module in &map.modules {
        let ModuleAddr::Can(addr) = module.addr else {
            silent.push(module.name);
            continue;
        };
        match open_channel(
            bus.clone(),
            bitrate,
            addr,
            Arc::clone(&interlock),
            Arc::clone(&lock),
        )
        .await
        {
            Ok(mut ch) => {
                let reading = heuristics::collect_module(&mut ch, module).await;
                let missing = (module.vin.is_some() && reading.vin.is_none())
                    || (module.odometer.is_some() && reading.odometer_km.is_none());
                if missing {
                    silent.push(module.name);
                }
                readings.push(reading);
            }
            Err(e) => {
                tracing::debug!("audit: no channel to {}: {e}", module.name);
                silent.push(module.name);
            }
        }
    }
    let status = match map.modules.iter().find(|m| m.obd).map(|m| m.addr) {
        Some(ModuleAddr::Can(_)) => {
            match open_channel(
                bus.clone(),
                bitrate,
                CanAddressing::obd_functional(0x7E8),
                Arc::clone(&interlock),
                Arc::clone(&lock),
            )
            .await
            {
                Ok(mut ch) => heuristics::collect_obd_status(&mut ch).await,
                Err(_) => (None, None),
            }
        }
        _ => (None, None),
    };
    let mut alerts = heuristics::cross_module_audit(&heuristics::audit_input(
        Some(&map),
        readings.clone(),
        status,
    ));
    let modules: Vec<serde_json::Value> = readings
        .iter()
        .map(|r| json!({ "module": r.module, "vin": r.vin, "odometer_km": r.odometer_km }))
        .collect();
    if !silent.is_empty() {
        alerts.push(heuristics::alert(
            "audit.incomplete",
            m::Severity::Info,
            "VIN and odometer audit incomplete: some modules did not answer",
            json!({ "modules_not_read": silent, "modules": modules }),
            "Check the ignition is on and each module is powered, then reconnect to re-run the audit.",
        ));
    } else if alerts.is_empty() {
        alerts.push(heuristics::alert(
            "audit.consistent",
            m::Severity::Info,
            "VIN and odometer agree across modules; codes not recently cleared",
            json!({
                "modules": modules,
                "distance_since_clear_km": status.0,
                "incomplete_monitors": status.1,
                "odometer_tolerance_km": heuristics::ODOMETER_TOLERANCE_KM,
            }),
            "",
        ));
    }
    alerts
}

async fn stream_can(
    mut port: impl VehicleBusAdapter + 'static,
    tx: mpsc::Sender<Outbound>,
    period: Duration,
    allow_raw_can: bool,
) {
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut frames: Vec<m::CanFrame> = Vec::new();
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if frames.is_empty() || !allow_raw_can {
                    frames.clear();
                    continue;
                }
                let batch = m::CanFrameBatch { frames: std::mem::take(&mut frames), type_: m::CanFrameBatchType::CanFrameBatch };
                if let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(Outbound::Msg(batch.into())) {
                    return;
                }
            }
            received = port.recv_frame(period) => match received {
                Ok(f) => {
                    frames.push(m::CanFrame {
                        can_id: m::CanId(f.id()),
                        data_hex: to_hex(f.data()).as_str().try_into().expect("at most 8 bytes"),
                        dlc: f.dlc(),
                        is_extended: f.is_extended(),
                        timestamp_us: m::TimestampUs(now_us()),
                    });
                    if frames.len() > 5_000 {
                        frames.remove(0);
                    }
                }
                Err(HalError::Timeout(_)) => {}
                Err(_) => return,
            },
        }
    }
}

async fn stream_pids(
    mut ch: DiagChannel,
    interlock: Arc<SafetyInterlock>,
    tx: mpsc::Sender<Outbound>,
    period: Duration,
) {
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut cycle = 0u32;
    // Recent samples for the live heuristics (fuel-trim matrix, cold-soak).
    let mut history: std::collections::VecDeque<m::PidSample> = std::collections::VecDeque::new();
    let mut raised: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Ask only for what the ECU supports (Rule 6: the rest shows as not
    // supported, never as a value). If the bitmap can't be read, or reads as
    // empty, ask for all: an ECU leaves out PIDs it doesn't support.
    let supported = match Obd(&mut ch).supported_pids().await {
        Ok(s) if !s.is_empty() => Some(s),
        Ok(_) => {
            tracing::warn!("ECU reported no supported PIDs; polling the full live set");
            None
        }
        Err(e) => {
            tracing::warn!("supported-PID bitmap unreadable ({e}); polling the full live set");
            None
        }
    };
    let keep = |pids: &[u8]| -> Vec<u8> {
        pids.iter()
            .copied()
            .filter(|p| supported.as_ref().is_none_or(|s| s.contains(p)))
            .collect()
    };
    let (fast, slow) = (keep(&FAST_PIDS), keep(&SLOW_PIDS));
    loop {
        tick.tick().await;
        cycle = cycle.wrapping_add(1);
        let mut values = Vec::new();
        let slow_due = cycle % SLOW_EVERY == 1;
        for group in [Some(&fast), slow_due.then_some(&slow)]
            .into_iter()
            .flatten()
        {
            if group.is_empty() {
                continue;
            }
            match Obd(&mut ch).read_pids(group).await {
                Ok(v) => values.extend(v),
                Err(e) => tracing::debug!("PID poll failed: {e}"),
            }
        }
        if values.is_empty() {
            continue;
        }
        if cycle % 20 == 1 {
            if let Ok(battery) = Obd(&mut ch).read_pids(&[0x42]).await {
                values.extend(battery);
            }
        }
        let ts = now_us();
        for v in &values {
            match v.pid {
                0x0D => interlock.update_speed(v.value),
                0x0C => interlock.update_rpm(v.value),
                0x42 => interlock.update_battery(v.value),
                _ => {}
            }
        }
        let samples = values
            .into_iter()
            .filter_map(|v| {
                Some(m::PidSample {
                    name: v.name.try_into().ok()?,
                    pid: u16::from(v.pid),
                    timestamp_us: m::TimestampUs(ts),
                    unit: v.unit.try_into().ok()?,
                    value: v.value,
                })
            })
            .collect();
        let samples: Vec<m::PidSample> = samples;
        history.extend(samples.iter().cloned());
        while history.len() > HEURISTIC_HISTORY {
            history.pop_front();
        }
        if cycle.is_multiple_of(20) {
            let snapshot: Vec<m::PidSample> = history.iter().cloned().collect();
            let mut found = heuristics::fuel_trim(&snapshot);
            found.extend(heuristics::cold_soak(&snapshot));
            for alert in found {
                if raised.insert(alert.rule_id.to_string()) {
                    if let Err(mpsc::error::TrySendError::Closed(_)) =
                        tx.try_send(Outbound::Msg(alert.into()))
                    {
                        return;
                    }
                }
            }
        }
        let stream = m::ObdPidStream {
            samples,
            type_: m::ObdPidStreamType::ObdPidStream,
        };
        if let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(Outbound::Msg(stream.into()))
        {
            return;
        }
    }
}

#[cfg(test)]
mod channel_cap_tests {
    use super::{lru_touch, MAX_DIAG_CHANNELS};
    use std::collections::VecDeque;

    #[test]
    fn a_sweep_never_keeps_more_than_the_cap_open() {
        let mut order = VecDeque::new();
        let mut open = 0usize;
        // A full 11-bit sweep: 248 addresses, each touched once.
        for tx in 0x700u32..=0x7F7 {
            open += 1;
            open -= lru_touch(&mut order, (tx, tx + 8), MAX_DIAG_CHANNELS).len();
            assert!(open <= MAX_DIAG_CHANNELS);
        }
        assert_eq!(order.len(), MAX_DIAG_CHANNELS);
        // The most recent addresses are the ones kept.
        assert_eq!(order.back(), Some(&(0x7F7, 0x7FF)));
    }

    #[test]
    fn reusing_a_channel_refreshes_it_and_evicts_the_oldest() {
        let mut order = VecDeque::new();
        for k in [1, 2, 3] {
            assert!(lru_touch(&mut order, k, 3).is_empty());
        }
        // Touch 1 again: it becomes newest, nothing evicted.
        assert!(lru_touch(&mut order, 1, 3).is_empty());
        // A fourth key evicts 2, the least recently used, not 1.
        assert_eq!(lru_touch(&mut order, 4, 3), vec![2]);
        assert_eq!(order, VecDeque::from([3, 1, 4]));
    }
}
