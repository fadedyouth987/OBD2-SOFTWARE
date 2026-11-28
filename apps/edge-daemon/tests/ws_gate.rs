//! Task 1.4 verification gate: real WebSocket clients against the daemon's
//! server on a free loopback port.

use std::{sync::Arc, time::Duration};

use ed25519_dalek::SigningKey;
use edge_daemon::{
    auth::{cloud_keys::KeyRing, jws, unix_now},
    protocol,
    safety::audit::MemoryAudit,
    server::{
        pairing::PairingStore,
        ws::{Server, ServerConfig, HELLO_TIMEOUT, MAX_MESSAGE_BYTES},
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

/// Gate: pair, list adapters, connect to the virtual bus, stream at >= 20 Hz.
#[tokio::test]
async fn pair_list_connect_and_stream_at_20hz() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;

    send(
        &mut ws,
        &json!({"type": "AdapterListRequest", "request_id": "l1"}),
    )
    .await;
    let list = reply(&mut ws, "l1").await;
    let ids: Vec<&str> = list["adapters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["adapter_id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"virtual-generic-uds"), "{ids:?}");

    send(
        &mut ws,
        &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-generic-uds",
                          "protocol": "AUTO", "baud_rate": null, "safety_mode": "SILENT"}),
    )
    .await;
    let status = reply(&mut ws, "c1").await;
    assert_eq!(
        (status["type"].as_str(), status["state"].as_str()),
        (Some("AdapterStatus"), Some("CONNECTED")),
        "{status}"
    );

    // Count streamed messages over one second, after a short warm-up.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let (mut pids, mut frames, mut saw_rpm) = (0, 0, false);
    let start = Instant::now();
    while Instant::now() - start < Duration::from_secs(1) {
        let msg = next(&mut ws).await.unwrap();
        match msg["type"].as_str().unwrap() {
            "ObdPidStream" => {
                pids += 1;
                saw_rpm |= msg["samples"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|s| s["pid"] == 12);
            }
            "CanFrameBatch" => frames += 1,
            _ => {}
        }
    }
    assert!(pids >= 20, "ObdPidStream at {pids} Hz");
    assert_eq!(
        frames, 0,
        "raw CAN is gated on CAN_RE_PRO; got {frames} batches"
    );
    assert!(saw_rpm);

    // Diagnostics over the socket: an ungated read works, a gated one is blocked in SILENT.
    send(&mut ws, &diag("d1", 0x7E0, 0x7E8, "22F190")).await;
    let vin = reply(&mut ws, "d1").await;
    assert_eq!(vin["positive"], true, "{vin}");
    assert!(vin["response_hex"].as_str().unwrap().starts_with("62F190"));
    send(&mut ws, &diag("d2", 0x7E0, 0x7E8, "2F0B2A0301")).await;
    assert_eq!(reply(&mut ws, "d2").await["code"], "SAFETY_BLOCKED");

    send(&mut ws, &json!({"type": "DisconnectRequest", "request_id": "x1", "adapter_id": "virtual-generic-uds"})).await;
    assert_eq!(reply(&mut ws, "x1").await["state"], "DISCONNECTED");
}

/// Gate: disallowed Origin and wrong Host are refused at the upgrade.
#[tokio::test]
async fn origin_and_host_checks() {
    let d = start(|_, _| {}).await;
    assert!(
        d.ws(None, Some("https://evil.example")).await.is_err(),
        "disallowed Origin"
    );
    assert!(
        d.ws(Some("evil.example"), Some(APP)).await.is_err(),
        "rebinding Host"
    );
    assert!(
        d.ws(Some("127.0.0.1:9999"), Some(APP)).await.is_err(),
        "wrong port in Host"
    );
    let port = d.port;
    for host in [format!("localhost:{port}"), format!("127.0.0.1:{port}")] {
        assert!(d.ws(Some(&host), Some(APP)).await.is_ok(), "{host}");
    }
}

/// Gate: no Hello within the timeout (5 s by default; shortened here) and
/// DiagCommandRequest before Hello both get UNAUTHENTICATED and a close.
#[tokio::test]
async fn hello_is_required_first() {
    assert_eq!(HELLO_TIMEOUT, Duration::from_secs(5));
    let d = start(|cfg, _| cfg.hello_timeout = Duration::from_millis(300)).await;
    let mut silent = d.app().await;
    closes_with(&mut silent, "UNAUTHENTICATED").await;

    let mut eager = d.app().await;
    send(&mut eager, &diag("d0", 0x7E0, 0x7E8, "22F190")).await;
    closes_with(&mut eager, "UNAUTHENTICATED").await;
}

/// Gate: a pairing code works once.
#[tokio::test]
async fn reused_pairing_code_is_refused() {
    let d = start(|_, _| {}).await;
    let code = d.code();
    let mut first = d.app().await;
    send(&mut first, &hello(&code)).await;
    assert_eq!(next(&mut first).await.unwrap()["type"], "HelloResponse");
    let mut second = d.app().await;
    send(&mut second, &hello(&code)).await;
    closes_with(&mut second, "UNAUTHENTICATED").await;
}

#[tokio::test]
async fn cloud_pairing_tokens_and_native_clients() {
    let d = start(|_, _| {}).await;
    // Browser with a JWT bound to its origin.
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.pairing_jwt(APP))).await;
    assert_eq!(next(&mut ws).await.unwrap()["type"], "HelloResponse");
    // JWT minted for another origin.
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.pairing_jwt("https://other.example"))).await;
    closes_with(&mut ws, "UNAUTHENTICATED").await;
    // Native client (no Origin): JWTs refused, local codes accepted.
    let mut native = d.ws(None, None).await.unwrap();
    send(&mut native, &hello(&d.pairing_jwt(APP))).await;
    closes_with(&mut native, "UNAUTHENTICATED").await;
    let mut native = d.ws(None, None).await.unwrap();
    send(&mut native, &hello(&d.code())).await;
    assert_eq!(next(&mut native).await.unwrap()["type"], "HelloResponse");
}

/// A-ENG-3, daemon side: incompatible protocol majors are refused with an update hint, both ways.
#[tokio::test]
async fn version_mismatch_both_ways() {
    let d = start(|_, _| {}).await;
    for version in ["2.0.0", "0.9.0"] {
        let mut ws = d.app().await;
        let mut h = hello(&d.code());
        h["protocol_version"] = json!(version);
        send(&mut ws, &h).await;
        let msg = next(&mut ws).await.unwrap();
        assert_eq!(msg["code"], "VERSION_UNSUPPORTED", "{version}");
        assert!(msg["hint"].as_str().unwrap().contains("update"));
        assert!(next(&mut ws).await.is_none());
    }
    let mut ws = d.app().await;
    let mut h = hello(&d.code());
    h["protocol_version"] = json!("1.7.3"); // newer minor is fine
    send(&mut ws, &h).await;
    assert_eq!(next(&mut ws).await.unwrap()["type"], "HelloResponse");
}

/// Leases: a valid one unlocks features; one signed by an unknown key, or
/// expired, leaves the session at COMMUNITY. ACTIVE_CONFIRMED needs UDS_ACTIVE.
#[tokio::test]
async fn leases_set_tier_and_features() {
    let now = unix_now();
    let claims = |exp: u64| json!({"aud": "edge-daemon", "tenant_id": "t-1", "tier": "WORKSHOP", "features": ["UDS_ACTIVE", "CAN_RE_PRO"], "nbf": now - 60, "exp": exp});

    let d = start(|cfg, cloud| {
        cfg.lease_token = Some(jws::sign(&claims(now + 3_600), "cloud-test", cloud))
    })
    .await;
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.code())).await;
    let h = next(&mut ws).await.unwrap();
    assert_eq!(
        (
            h["lease_tier"].as_str(),
            h["features"].as_array().unwrap().len()
        ),
        (Some("WORKSHOP"), 2)
    );
    send(&mut ws, &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-generic-uds", "protocol": "AUTO", "baud_rate": null, "safety_mode": "ACTIVE_CONFIRMED"})).await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");

    let rogue = SigningKey::from_bytes(&[99; 32]);
    for token in [
        jws::sign(&claims(now + 3_600), "cloud-test", &rogue),
        jws::sign(&claims(now + 3_600), "rogue", &rogue),
    ] {
        let d = start(move |cfg, _| cfg.lease_token = Some(token)).await;
        let mut ws = d.app().await;
        send(&mut ws, &hello(&d.code())).await;
        assert_eq!(
            next(&mut ws).await.unwrap()["lease_tier"],
            "COMMUNITY",
            "unknown key"
        );
    }
    let d = start(|cfg, cloud| {
        let mut expired = claims(now - 1_000);
        expired["nbf"] = json!(now - 7_200);
        cfg.lease_token = Some(jws::sign(&expired, "cloud-test", cloud));
    })
    .await;
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.code())).await;
    assert_eq!(
        next(&mut ws).await.unwrap()["lease_tier"],
        "COMMUNITY",
        "expired"
    );
    send(&mut ws, &json!({"type": "ConnectRequest", "request_id": "c2", "adapter_id": "virtual-generic-uds", "protocol": "AUTO", "baud_rate": null, "safety_mode": "ACTIVE_CONFIRMED"})).await;
    assert_eq!(reply(&mut ws, "c2").await["code"], "LEASE_REQUIRED");
}

#[tokio::test]
async fn oversized_message_closes_the_connection() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    let huge = "x".repeat(MAX_MESSAGE_BYTES + 1);
    let _ = ws.send(Message::text(huge)).await;
    assert!(next(&mut ws).await.is_none());
}

#[tokio::test]
async fn diag_commands_are_rate_limited() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    send(&mut ws, &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-generic-uds", "protocol": "AUTO", "baud_rate": null, "safety_mode": "SILENT"})).await;
    reply(&mut ws, "c1").await;
    // Gated requests are refused before the bus, so the server answers as fast as they arrive.
    for i in 0..25 {
        send(&mut ws, &diag(&format!("r{i}"), 0x7E0, 0x7E8, "2F0B2A0301")).await;
    }
    let mut limited = 0;
    for i in 0..25 {
        let r = reply(&mut ws, &format!("r{i}")).await;
        if r["message"]
            .as_str()
            .is_some_and(|m| m.contains("rate limit"))
        {
            limited += 1;
        }
    }
    assert!(limited >= 4, "{limited} of 25 rate-limited");
}

#[tokio::test]
async fn protocol_errors_keep_the_session() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    send(&mut ws, &hello("123456")).await;
    assert_eq!(reply(&mut ws, "h1").await["code"], "PROTOCOL_ERROR");
    ws.send(Message::text("{not json")).await.unwrap();
    assert_eq!(next(&mut ws).await.unwrap()["code"], "PROTOCOL_ERROR");
    send(&mut ws, &diag("d1", 0x7E0, 0x7E8, "22F190")).await;
    assert_eq!(
        reply(&mut ws, "d1").await["code"],
        "ADAPTER_ERROR",
        "not connected yet"
    );
    let mut lying = diag("d2", 0x7E0, 0x7E8, "2F0B2A0301");
    lying["service_id"] = json!(0x22); // claims a harmless read, payload is IOControl
    send(&mut ws, &lying).await;
    assert_eq!(
        reply(&mut ws, "d2").await["code"],
        "PROTOCOL_ERROR",
        "service_id must match the payload"
    );
    send(&mut ws, &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-bmw-e90-pre2007", "protocol": "AUTO", "baud_rate": null, "safety_mode": "SILENT"})).await;
    assert_eq!(
        reply(&mut ws, "c1").await["code"],
        "ADAPTER_ERROR",
        "K-line live view is Task 4.1"
    );
}

/// Raw CAN frames are streamed only when the lease includes CAN_RE_PRO.
#[tokio::test]
async fn can_re_pro_is_required_for_raw_can_frames() {
    let now = unix_now();
    let d = start(|cfg, cloud| {
        cfg.lease_token = Some(jws::sign(
            &json!({
                "aud": "edge-daemon",
                "tenant_id": "t-1",
                "tier": "WORKSHOP",
                "features": ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"],
                "nbf": now - 60,
                "exp": now + 3_600
            }),
            "cloud-test",
            cloud,
        ));
    })
    .await;
    let mut ws = paired(&d).await;
    send(
        &mut ws,
        &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-generic-uds",
                          "protocol": "AUTO", "baud_rate": null, "safety_mode": "SILENT"}),
    )
    .await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");
    tokio::time::sleep(Duration::from_millis(150)).await;
    let mut frames = 0;
    let start = Instant::now();
    while Instant::now() - start < Duration::from_secs(1) {
        let msg = next(&mut ws).await.unwrap();
        if msg["type"] == "CanFrameBatch" {
            frames += 1;
        }
    }
    assert!(
        frames >= 20,
        "workshop lease streams raw CAN at {frames} Hz"
    );
}

/// A lease bound to another device, or an old lease generation, is COMMUNITY.
#[tokio::test]
async fn device_mismatch_and_revoked_generation_deny_paid_features() {
    let now = unix_now();
    let claims = json!({
        "aud": "edge-daemon",
        "tenant_id": "t-1",
        "tier": "WORKSHOP",
        "features": ["UDS_ACTIVE", "CAN_RE_PRO"],
        "rcid": "RC-DGL-04A2",
        "lease_ver": 2,
        "nbf": now - 60,
        "exp": now + 3_600
    });

    let d = start(|cfg, cloud| {
        cfg.device_id = Some("OTHER-DEVICE".into());
        cfg.lease_token = Some(jws::sign(&claims, "cloud-test", cloud));
    })
    .await;
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.code())).await;
    let h = next(&mut ws).await.unwrap();
    assert_eq!(h["lease_tier"], "COMMUNITY", "wrong device: {h}");
    assert!(h["features"].as_array().unwrap().is_empty());

    let d = start(|cfg, cloud| {
        cfg.device_id = Some("RC-DGL-04A2".into());
        cfg.lease_min_version
            .store(3, std::sync::atomic::Ordering::SeqCst);
        cfg.lease_token = Some(jws::sign(&claims, "cloud-test", cloud));
    })
    .await;
    let mut ws = d.app().await;
    send(&mut ws, &hello(&d.code())).await;
    let h = next(&mut ws).await.unwrap();
    assert_eq!(h["lease_tier"], "COMMUNITY", "revoked: {h}");
}

/// Bumping the lease epoch closes an already-authenticated socket.
#[tokio::test]
async fn lease_epoch_closes_open_sockets() {
    let now = unix_now();
    let epoch = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let epoch_for_cfg = std::sync::Arc::clone(&epoch);
    let d = start(move |cfg, cloud| {
        cfg.lease_epoch = epoch_for_cfg;
        cfg.lease_token = Some(jws::sign(
            &json!({
                "aud": "edge-daemon",
                "tenant_id": "t-1",
                "tier": "PRO",
                "features": ["UDS_ACTIVE"],
                "nbf": now - 60,
                "exp": now + 3_600
            }),
            "cloud-test",
            cloud,
        ));
    })
    .await;
    let mut ws = paired(&d).await;
    epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    send(
        &mut ws,
        &json!({"type": "AdapterListRequest", "request_id": "l1"}),
    )
    .await;
    let msg = next(&mut ws).await.unwrap();
    assert_eq!(msg["type"], "ErrorResponse");
    assert_eq!(msg["code"], "TOKEN_INVALID");
    assert!(next(&mut ws).await.is_none(), "socket should close");
}

/// The PIDs one virtual vehicle streams over about a second.
async fn streamed_pids(adapter: &str) -> std::collections::BTreeSet<u64> {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    send(
        &mut ws,
        &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": adapter,
                "protocol": "AUTO", "baud_rate": null, "safety_mode": "SILENT"}),
    )
    .await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");
    let mut seen = std::collections::BTreeSet::new();
    let start = Instant::now();
    while Instant::now() - start < Duration::from_millis(1200) {
        let msg = next(&mut ws).await.unwrap();
        if msg["type"] == "ObdPidStream" {
            for s in msg["samples"].as_array().unwrap() {
                seen.insert(s["pid"].as_u64().unwrap());
            }
        }
    }
    seen
}

/// Task 4.1 scope: RPM, MAF, STFT/LTFT B1/B2, ECT and IAT stream (plus speed for
/// the interlock and battery), and a PID the ECU doesn't support never does (Rule 6).
#[tokio::test]
async fn streams_the_contract_pids_and_only_supported_ones() {
    let falcon = streamed_pids("virtual-ford-falcon-ba").await;
    for pid in [0x0C, 0x0D, 0x10, 0x06, 0x07, 0x08, 0x09, 0x05, 0x0F] {
        assert!(
            falcon.contains(&pid),
            "Falcon PID 0x{pid:02X} missing from {falcon:?}"
        );
    }
    let polled = [0x0C, 0x0D, 0x10, 0x06, 0x07, 0x08, 0x09, 0x05, 0x0F, 0x42];
    assert!(falcon.iter().all(|p| polled.contains(p)), "{falcon:?}");
    // The generic engine ECU has a single bank: no bank 2 trims.
    let generic = streamed_pids("virtual-generic-uds").await;
    assert!(generic.contains(&0x10), "{generic:?}");
    assert!(
        !generic.contains(&0x08) && !generic.contains(&0x09),
        "{generic:?}"
    );
}

/// Task 6.2: a FORScan-style module sweep over the socket. TesterPresent to
/// every 11-bit address 0x700-0x7F7 finds exactly the modules the virtual
/// Falcon simulates, absent addresses time out, and the session keeps working
/// after hundreds of channels (the per-connection channel cap).
#[tokio::test]
async fn tester_present_sweep_finds_exactly_the_simulated_modules() {
    let d = start(|_, _| {}).await;
    let mut ws = paired(&d).await;
    send(&mut ws, &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-ford-falcon-ba", "protocol": "AUTO", "baud_rate": null, "safety_mode": "SILENT"})).await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");

    let started = Instant::now();
    let mut found = Vec::new();
    for tx in (0x700u32..=0x7F7).filter(|t| *t != 0x7DF) {
        loop {
            let id = format!("p{tx:x}");
            send(&mut ws, &diag(&id, tx, tx + 8, "3E00")).await;
            let r = reply(&mut ws, &id).await;
            match (r["type"].as_str(), r["code"].as_str()) {
                (Some("DiagCommandResponse"), _) => {
                    found.push(tx);
                    break;
                }
                (Some("ErrorResponse"), Some("TIMEOUT")) => break,
                (Some("ErrorResponse"), _)
                    if r["message"]
                        .as_str()
                        .is_some_and(|m| m.contains("rate limit")) =>
                {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                _ => panic!("unexpected reply at {tx:#x}: {r}"),
            }
        }
    }
    assert_eq!(
        found,
        vec![0x720, 0x760, 0x7E0],
        "IC, ABS and PCM answer; nothing else"
    );
    let took = started.elapsed();
    assert!(took < Duration::from_secs(40), "sweep took {took:?}");

    // The first channels were closed long ago by the cap; reopening one still works.
    send(&mut ws, &diag("again", 0x7E0, 0x7E8, "3E00")).await;
    assert_eq!(reply(&mut ws, "again").await["type"], "DiagCommandResponse");
}
