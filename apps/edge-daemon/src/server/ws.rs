//! Secured local WebSocket server (Task 1.4, Rule 4).
//!
//! The socket can actuate a vehicle, so it is treated as privileged:
//!
//! - Binds 127.0.0.1 and [::1] only.
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
//! This task streams from the virtual vehicles; real-adapter sessions (one
//! physical bus shared between streaming and diagnostics) arrive with Task 4.1.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::mpsc,
    task::JoinHandle,
    time::Instant,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::{header, StatusCode},
        protocol::WebSocketConfig,
        Message,
    },
};

use super::pairing::{looks_like_code, PairingStore};
use crate::{
    auth::{
        cloud_keys::KeyRing,
        lease::{self, Lease},
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
/// PIDs polled for the live view and the interlock (max six per request).
const LIVE_PIDS: [u8; 6] = [0x0C, 0x0D, 0x05, 0x0F, 0x06, 0x07];

pub struct ServerConfig {
    pub port: u16,
    pub allowed_origins: Vec<String>,
    pub keys: KeyRing,
    /// Raw lease token; verified at every Hello so expiry takes effect.
    pub lease_token: Option<String>,
    pub pairing: Arc<PairingStore>,
    pub audit: Arc<dyn AuditSink>,
    pub hello_timeout: Duration,
    pub max_message_bytes: usize,
    pub diag_per_second: u32,
    pub stream_period: Duration,
}

impl ServerConfig {
    pub fn new(keys: KeyRing, pairing: Arc<PairingStore>, audit: Arc<dyn AuditSink>) -> Self {
        Self {
            port: DEFAULT_PORT,
            allowed_origins: vec!["http://localhost:3000".into()],
            keys,
            lease_token: None,
            pairing,
            audit,
            hello_timeout: HELLO_TIMEOUT,
            max_message_bytes: MAX_MESSAGE_BYTES,
            diag_per_second: DIAG_PER_SECOND,
            stream_period: STREAM_PERIOD,
        }
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
        Ok(Self {
            listeners,
            cfg: Arc::new(cfg),
        })
    }

    pub fn port(&self) -> u16 {
        self.cfg.port
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
                            tokio::spawn(handle(Arc::clone(&cfg), stream));
                        }
                        Err(e) => tracing::warn!("accept failed: {e}"),
                    }
                }
            }));
        }
        for l in accept_loops {
            let _ = l.await;
        }
    }
}

fn reject(why: &str) -> ErrorResponse {
    let mut resp = ErrorResponse::new(Some(why.to_owned()));
    *resp.status_mut() = StatusCode::FORBIDDEN;
    resp
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
async fn handle(cfg: Arc<ServerConfig>, stream: TcpStream) {
    let origin_slot: Arc<Mutex<Option<String>>> = Arc::default();
    let slot = Arc::clone(&origin_slot);
    let check_cfg = Arc::clone(&cfg);
    let callback = move |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
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
        Ok(Some(text)) => authenticate(&cfg, origin.as_deref(), &text, tx.clone()),
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

    while let Some(text) = next_text(&mut source).await {
        let reply = session.handle(&text).await;
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
    cfg: &ServerConfig,
    origin: Option<&str>,
    text: &str,
    tx: mpsc::Sender<Outbound>,
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
    let user = if looks_like_code(token) {
        if !cfg.pairing.consume(token, now) {
            return Err(err(
                rid,
                ErrorCode::Unauthenticated,
                "pairing code is wrong, expired or already used",
            ));
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
            Ok(p) => Some(p.user_id),
            Err(e) => {
                return Err(err(
                    rid,
                    ErrorCode::Unauthenticated,
                    &format!("pairing token rejected: {e}"),
                ))
            }
        }
    };
    let lease = lease::effective_lease(cfg.lease_token.as_deref(), &cfg.keys, now);
    let session_id = random_session_id();
    let interlock = Arc::new(SafetyInterlock::new(
        session_id.clone(),
        Arc::clone(&cfg.audit),
    ));
    interlock.set_identity(user, None);
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
    tracing::info!(%session_id, tier = %lease.tier, "client authenticated");
    let session = Session {
        lease,
        interlock,
        conn: None,
        bucket: Bucket::new(cfg.diag_per_second),
        tx,
        stream_period: cfg.stream_period,
    };
    Ok((session, hello_resp.into()))
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
    tasks: Vec<JoinHandle<()>>,
    channels: HashMap<(u32, u32), DiagChannel>,
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
    interlock: Arc<SafetyInterlock>,
    conn: Option<Connected>,
    bucket: Bucket,
    tx: mpsc::Sender<Outbound>,
    stream_period: Duration,
}

/// A diagnostic channel on its own port of the virtual or shared physical bus.
async fn open_channel(
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
            _ => err(
                request_id_of(text),
                ErrorCode::ProtocolError,
                "that message type is sent by the daemon, not the app",
            ),
        }
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
            let mut tasks = vec![tokio::spawn(stream_can(
                shared.port(),
                self.tx.clone(),
                self.stream_period,
            ))];
            match open_channel(
                bus.clone(),
                bitrate,
                CanAddressing::obd_functional(0x7E8),
                Arc::clone(&self.interlock),
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
            self.interlock.set_mode(r.safety_mode);
            self.conn = Some(Connected {
                adapter_id: adapter_id.to_owned(),
                bus,
                tasks,
                channels: HashMap::new(),
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
                "live view of K-line vehicles arrives with Task 4.1",
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
        let bus = match VirtualBus::new(profile) {
            Ok(bus) => bus,
            Err(e) => return err(rid, ErrorCode::AdapterError, &e.to_string()),
        };
        let mut frames = bus.adapter();
        if let Err(e) = frames.open(bitrate).await {
            return err(rid, ErrorCode::AdapterError, &e.to_string());
        }
        let bus_handle = BusHandle::Virtual(bus.clone());
        let mut tasks = vec![tokio::spawn(stream_can(
            frames,
            self.tx.clone(),
            self.stream_period,
        ))];
        match open_channel(
            bus_handle.clone(),
            bitrate,
            CanAddressing::obd_functional(0x7E8),
            Arc::clone(&self.interlock),
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
        self.interlock.set_mode(r.safety_mode);
        let battery = bus.with_vehicle(|v| v.battery_v);
        self.conn = Some(Connected {
            adapter_id: adapter_id.to_owned(),
            bus: bus_handle,
            tasks,
            channels: HashMap::new(),
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
            let (bus, bitrate) = (conn.bus.clone(), conn.bus.bitrate());
            // Local box fix: r.protocol is DiagProtocol, not BusProtocol.
            // BMW D-CAN extended addressing is detected from IDs (0x6F1 / 0x6xx).
            let addressing = if key.0 == 0x6F1 && (0x600..=0x6FF).contains(&key.1) {
                CanAddressing::BmwExtended {
                    ecu: (key.1 & 0xFF) as u8,
                }
            } else {
                CanAddressing::normal(key.0, key.1)
            };
            match open_channel(bus, bitrate, addressing, Arc::clone(&self.interlock)).await {
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
        let ch = self
            .conn
            .as_mut()
            .expect("checked above")
            .channels
            .get_mut(&key)
            .expect("inserted above");
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

async fn stream_can(
    mut port: impl VehicleBusAdapter + 'static,
    tx: mpsc::Sender<Outbound>,
    period: Duration,
) {
    let mut tick = tokio::time::interval(period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut frames: Vec<m::CanFrame> = Vec::new();
    loop {
        tokio::select! {
            _ = tick.tick() => {
                if frames.is_empty() {
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
    loop {
        tick.tick().await;
        cycle = cycle.wrapping_add(1);
        let mut values = match Obd(&mut ch).read_pids(&LIVE_PIDS).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!("PID poll failed: {e}");
                continue;
            }
        };
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
