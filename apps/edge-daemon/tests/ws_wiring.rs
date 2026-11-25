//! UI wiring gate: lease status/install over the socket, the cross-module audit
//! pushed on connect, and a simulated service routine through the interlock.

#![allow(dead_code)] // shared helpers copied from ws_gate.rs

use std::{sync::Arc, time::Duration};

use ed25519_dalek::SigningKey;
use edge_daemon::{
    auth::{cloud_keys::KeyRing, jws, unix_now},
    protocol,
    safety::audit::MemoryAudit,
    server::{
        pairing::PairingStore,
        ws::{Server, ServerConfig},
    },
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{net::TcpStream, time::Instant};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
    MaybeTlsStream, WebSocketStream,
};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const APP: &str = "http://localhost:3000";

struct Daemon {
    port: u16,
    pairing: Arc<PairingStore>,
    cloud: SigningKey,
    _task: tokio::task::JoinHandle<()>,
}

async fn start(tweak: impl FnOnce(&mut ServerConfig, &SigningKey)) -> Daemon {
    let cloud = SigningKey::from_bytes(&[11; 32]);
    let keys =
        KeyRing::from_raw([("cloud-test".to_owned(), cloud.verifying_key().to_bytes())]).unwrap();
    let pairing = Arc::new(PairingStore::in_memory());
    let mut cfg = ServerConfig::new(keys, Arc::clone(&pairing), Arc::new(MemoryAudit::default()));
    cfg.port = 0;
    tweak(&mut cfg, &cloud);
    let server = Server::bind(cfg).await.unwrap();
    let port = server.port();
    Daemon {
        port,
        pairing,
        cloud,
        _task: tokio::spawn(server.run()),
    }
}

impl Daemon {
    fn code(&self) -> String {
        self.pairing.issue(unix_now()).unwrap()
    }

    async fn ws(
        &self,
        host: Option<&str>,
        origin: Option<&str>,
    ) -> Result<Ws, tokio_tungstenite::tungstenite::Error> {
        let mut req = format!("ws://127.0.0.1:{}/", self.port)
            .into_client_request()
            .unwrap();
        let host = host.map_or_else(|| format!("127.0.0.1:{}", self.port), str::to_owned);
        req.headers_mut()
            .insert("host", HeaderValue::from_str(&host).unwrap());
        if let Some(o) = origin {
            req.headers_mut()
                .insert("origin", HeaderValue::from_str(o).unwrap());
        }
        connect_async(req).await.map(|(ws, _)| ws)
    }

    async fn app(&self) -> Ws {
        self.ws(None, Some(APP)).await.unwrap()
    }

    fn pairing_jwt(&self, origin: &str) -> String {
        let now = unix_now();
        jws::sign(
            &json!({"aud": "edge-ws", "user_id": "u-1", "tenant_id": "t-1", "origin": origin, "iat": now, "exp": now + 240}),
            "cloud-test",
            &self.cloud,
        )
    }
}

fn hello(token: &str) -> Value {
    json!({"type": "HelloRequest", "request_id": "h1", "client_token": token, "client_version": "0.1.0",
           "protocol_version": protocol::PROTOCOL_VERSION, "policy_version": protocol::policy_version()})
}

async fn send(ws: &mut Ws, v: &Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

/// Next message, or None when the server closed the connection.
async fn next(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .expect("server answered in time")
        {
            Some(Ok(Message::Text(t))) => {
                protocol::parse_message(t.as_str()).expect("daemon sends schema-valid messages");
                return Some(serde_json::from_str(t.as_str()).unwrap());
            }
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
            Some(Ok(_)) => continue,
        }
    }
}

/// The reply to `request_id`, skipping streamed messages.
async fn reply(ws: &mut Ws, request_id: &str) -> Value {
    loop {
        let msg = next(ws).await.expect("connection open");
        if msg["request_id"] == request_id {
            return msg;
        }
    }
}

async fn paired(d: &Daemon) -> Ws {
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.code())).await;
    let resp = next(&mut ws).await.unwrap();
    assert_eq!(resp["type"], "HelloResponse", "{resp}");
    ws
}

async fn closes_with(ws: &mut Ws, code: &str) {
    let msg = next(ws).await.expect("an ErrorResponse before closing");
    assert_eq!(
        (msg["type"].as_str(), msg["code"].as_str()),
        (Some("ErrorResponse"), Some(code)),
        "{msg}"
    );
    assert!(msg["hint"].as_str().is_some_and(|h| !h.is_empty()));
    assert!(next(ws).await.is_none(), "connection closed after {code}");
}

fn diag(id: &str, tx: u32, rx: u32, payload: &str) -> Value {
    let service_id = u8::from_str_radix(&payload[..2], 16).unwrap();
    json!({"type": "DiagCommandRequest", "request_id": id, "tx_id": tx, "rx_id": rx, "protocol": "UDS",
           "service_id": service_id, "payload_hex": payload, "safety_token": null})
}

fn lease(cloud: &SigningKey, tier: &str, features: &[&str]) -> String {
    let now = unix_now();
    jws::sign(
        &json!({"aud": "edge-daemon", "tenant_id": "t-1", "tier": tier, "features": features,
                "nbf": now - 60, "exp": now + 3_600}),
        "cloud-test",
        cloud,
    )
}

fn connect(id: &str, adapter: &str, mode: &str) -> Value {
    json!({"type": "ConnectRequest", "request_id": id, "adapter_id": adapter, "protocol": "AUTO",
           "baud_rate": null, "safety_mode": mode})
}

#[tokio::test]
async fn lease_status_and_install_keep_the_installing_socket() {
    let dir = std::env::temp_dir().join(format!("edge-wiring-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let dir_for_cfg = dir.clone();
    let d = start(move |cfg, _| cfg.data_dir = Some(dir_for_cfg)).await;
    let mut ws = paired(&d).await;
    let mut other = paired(&d).await;

    send(
        &mut ws,
        &json!({"type": "LeaseStatusRequest", "request_id": "s1"}),
    )
    .await;
    let status = reply(&mut ws, "s1").await;
    assert_eq!(status["type"], "LeaseStatus", "{status}");
    assert_eq!(status["lease_tier"], "COMMUNITY");
    assert_eq!(status["expires_at"], Value::Null);
    assert_eq!(status["cloud_keys_pinned"], true);

    // A forged lease is refused and the session carries on.
    let rogue = SigningKey::from_bytes(&[99; 32]);
    send(
        &mut ws,
        &json!({"type": "LeaseInstallRequest", "request_id": "i0", "kind": "DIAGNOSTIC",
                         "lease_token": lease(&rogue, "WORKSHOP", &["UDS_ACTIVE"])}),
    )
    .await;
    assert_eq!(reply(&mut ws, "i0").await["code"], "TOKEN_INVALID");

    let token = lease(&d.cloud, "WORKSHOP", &["UDS_ACTIVE", "CAN_RE_PRO"]);
    send(
        &mut ws,
        &json!({"type": "LeaseInstallRequest", "request_id": "i1", "kind": "DIAGNOSTIC",
                         "lease_token": token}),
    )
    .await;
    let installed = reply(&mut ws, "i1").await;
    assert_eq!(installed["type"], "LeaseStatus", "{installed}");
    assert_eq!(installed["lease_tier"], "WORKSHOP");
    assert!(installed["expires_at"].as_str().unwrap().ends_with('Z'));
    assert_eq!(
        std::fs::read_to_string(dir.join("lease.jwt")).unwrap(),
        token
    );

    // The installing socket stays open and gets the paid features at once.
    send(
        &mut ws,
        &connect("c1", "virtual-generic-uds", "ACTIVE_CONFIRMED"),
    )
    .await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");

    // Every other socket is asked to reconnect with the new lease.
    send(
        &mut other,
        &json!({"type": "AdapterListRequest", "request_id": "l1"}),
    )
    .await;
    assert_eq!(next(&mut other).await.unwrap()["code"], "TOKEN_INVALID");

    // A new connection picks the installed lease up.
    let mut fresh = d.app().await;
    send(&mut fresh, &hello(&d.code())).await;
    assert_eq!(next(&mut fresh).await.unwrap()["lease_tier"], "WORKSHOP");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn immo_lease_must_be_installed_as_immo_and_before_connect() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    let now = unix_now();
    let immo = jws::sign(
        &json!({"aud": "edge-daemon", "lease_kind": "immo_lease", "tenant_id": "t-1", "user_id": "u-1",
                "session_id": "immo-1", "jti": "j-1", "vin": "SBXTESTVAN0000001", "device_id": "virtual-sandbox-immo",
                "device_tier": "dongle", "oem": "sandbox", "operation": "add_key", "aasra_verified": true,
                "nbf": now - 10, "exp": now + 600}),
        "cloud-test",
        &d.cloud,
    );
    send(
        &mut ws,
        &json!({"type": "LeaseInstallRequest", "request_id": "i1", "kind": "DIAGNOSTIC",
                         "lease_token": immo}),
    )
    .await;
    assert_eq!(reply(&mut ws, "i1").await["code"], "TOKEN_INVALID");
    send(
        &mut ws,
        &json!({"type": "LeaseInstallRequest", "request_id": "i2", "kind": "IMMO",
                         "lease_token": immo}),
    )
    .await;
    let st = reply(&mut ws, "i2").await;
    assert_eq!(st["type"], "LeaseStatus", "{st}");
    assert!(st["immo_expires_at"].as_str().is_some());

    send(&mut ws, &connect("c1", "virtual-generic-uds", "SILENT")).await;
    assert_eq!(
        reply(&mut ws, "c1").await["type"],
        "ErrorResponse",
        "VIN-bound lease refuses another car"
    );
}

#[tokio::test]
async fn no_pinned_keys_means_no_cloud_leases() {
    let pairing = Arc::new(PairingStore::in_memory());
    let mut cfg = ServerConfig::new(
        KeyRing::default(),
        Arc::clone(&pairing),
        Arc::new(MemoryAudit::default()),
    );
    cfg.port = 0;
    let server = Server::bind(cfg).await.unwrap();
    let port = server.port();
    let _task = tokio::spawn(server.run());
    let mut req = format!("ws://127.0.0.1:{port}/")
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("origin", HeaderValue::from_static(APP));
    let (mut ws, _) = connect_async(req).await.unwrap();
    send(&mut ws, &hello(&pairing.issue(unix_now()).unwrap())).await;
    next(&mut ws).await.unwrap();
    send(
        &mut ws,
        &json!({"type": "LeaseStatusRequest", "request_id": "s1"}),
    )
    .await;
    assert_eq!(reply(&mut ws, "s1").await["cloud_keys_pinned"], false);
    send(
        &mut ws,
        &json!({"type": "LeaseInstallRequest", "request_id": "i1", "kind": "DIAGNOSTIC",
                         "lease_token": "aaaaaaaaaaaaaaaa.bbbb.cccc"}),
    )
    .await;
    assert_eq!(reply(&mut ws, "i1").await["code"], "LEASE_REQUIRED");
}

/// The next HeuristicAlert, skipping streamed frames.
async fn alert(ws: &mut Ws) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let msg = next(ws).await.expect("connection open");
        if msg["type"] == "HeuristicAlert" {
            return msg;
        }
    }
    panic!("no HeuristicAlert within 5 s");
}

#[tokio::test]
async fn audit_is_pushed_on_connect() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    send(&mut ws, &connect("c1", "virtual-ford-falcon-ba", "SILENT")).await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");
    let a = alert(&mut ws).await;
    assert_eq!(a["rule_id"], "audit.consistent", "{a}");
    assert_eq!(a["severity"], "INFO");
    assert_eq!(a["evidence_json"]["modules"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn service_routine_runs_only_with_a_safety_token() {
    let now = unix_now();
    let d = start(move |cfg, cloud| {
        cfg.lease_token = Some(jws::sign(
            &json!({"aud": "edge-daemon", "tenant_id": "t-1", "tier": "PRO", "features": ["UDS_ACTIVE"],
                    "nbf": now - 60, "exp": now + 3_600}),
            "cloud-test",
            cloud,
        ))
    })
    .await;
    let mut ws = paired(&d).await;
    send(
        &mut ws,
        &connect("c1", "virtual-generic-uds", "ACTIVE_CONFIRMED"),
    )
    .await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");
    // Let the PID poll feed the interlock a fresh speed reading.
    tokio::time::sleep(Duration::from_millis(400)).await;

    send(&mut ws, &diag("e1", 0x7E0, 0x7E8, "1003")).await;
    assert_eq!(reply(&mut ws, "e1").await["positive"], true);

    send(&mut ws, &diag("r0", 0x7E0, 0x7E8, "31010401")).await;
    let refused = reply(&mut ws, "r0").await;
    assert_eq!(refused["type"], "ErrorResponse", "{refused}");

    send(
        &mut ws,
        &json!({"type": "SafetyConfirmRequest", "request_id": "t1", "tx_id": 0x7E0, "rx_id": 0x7E8,
                         "protocol": "UDS", "service_id": 0x31, "payload_hex": "31010401",
                         "user_ack_text": "Throttle relearn on ENGINE; engine idle may change"}),
    )
    .await;
    let grant = reply(&mut ws, "t1").await;
    assert_eq!(grant["type"], "SafetyConfirmResponse", "{grant}");
    let token = grant["safety_token"].as_str().unwrap().to_owned();
    let mut run = diag("r1", 0x7E0, 0x7E8, "31010401");
    run["safety_token"] = json!(token);
    send(&mut ws, &run).await;
    let done = reply(&mut ws, "r1").await;
    assert_eq!(
        (done["positive"].as_bool(), done["response_hex"].as_str()),
        (Some(true), Some("7101040100")),
        "{done}"
    );
}

/// Runs one gated request the way the web app does: ask for a token, then send.
async fn gated(ws: &mut Ws, id: &str, tx: u32, rx: u32, sid: u8, payload: &str) -> Value {
    let tid = format!("{id}-t");
    send(
        ws,
        &json!({"type": "SafetyConfirmRequest", "request_id": tid, "tx_id": tx, "rx_id": rx,
                "protocol": "UDS", "service_id": sid, "payload_hex": payload,
                "user_ack_text": "Simulated service function; technician confirmed the checklist"}),
    )
    .await;
    let grant = reply(ws, &tid).await;
    assert_eq!(grant["type"], "SafetyConfirmResponse", "{grant}");
    let mut run = diag(id, tx, rx, payload);
    run["safety_token"] = grant["safety_token"].clone();
    send(ws, &run).await;
    reply(ws, id).await
}

#[tokio::test]
async fn falcon_service_functions_run_in_extended_session_without_security_access() {
    let now = unix_now();
    let d = start(move |cfg, cloud| {
        cfg.lease_token = Some(jws::sign(
            &json!({"aud": "edge-daemon", "tenant_id": "t-1", "tier": "PRO", "features": ["UDS_ACTIVE"],
                    "nbf": now - 60, "exp": now + 3_600}),
            "cloud-test",
            cloud,
        ))
    })
    .await;
    let mut ws = paired(&d).await;
    send(
        &mut ws,
        &connect("c1", "virtual-ford-falcon-ba", "ACTIVE_CONFIRMED"),
    )
    .await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Oil reset on the instrument cluster: routine 0x0501.
    send(&mut ws, &diag("e1", 0x720, 0x728, "1003")).await;
    assert_eq!(reply(&mut ws, "e1").await["positive"], true);
    let oil = gated(&mut ws, "oil", 0x720, 0x728, 0x31, "31010501").await;
    assert_eq!(oil["response_hex"], "7101050100", "{oil}");

    // ABS bleed: I/O control 0x4B01, handed back by leaving the session.
    send(&mut ws, &diag("e2", 0x760, 0x768, "1003")).await;
    assert_eq!(reply(&mut ws, "e2").await["positive"], true);
    let bleed = gated(&mut ws, "bleed", 0x760, 0x768, 0x2F, "2F4B010301").await;
    assert_eq!(bleed["response_hex"], "6F4B010301", "{bleed}");
    send(&mut ws, &diag("x2", 0x760, 0x768, "1001")).await;
    assert_eq!(reply(&mut ws, "x2").await["positive"], true);

    // Outside the extended session the routine is refused by the ECU (NRC 0x7F).
    let late = gated(&mut ws, "late", 0x760, 0x768, 0x31, "31010602").await;
    assert_eq!(late["positive"], false, "{late}");
}
