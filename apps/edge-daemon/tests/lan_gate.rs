//! Phone access gate: the opt-in network listener end to end, over real TLS
//! with the phone's certificate pinning, against the real server.
//!
//! Pairing from the PC's Devices page, the phone's pairing connection, its
//! credential, per-technician leases, a gated clear-codes request through the
//! safety interlock (with the phone named in the audit log), and revocation
//! closing the phone's socket at once. Plus every refusal on the way in.

use std::{net::IpAddr, sync::Arc, time::Duration};

use ed25519_dalek::SigningKey;
use edge_daemon::{
    auth::{cloud_keys::KeyRing, jws, unix_now},
    protocol,
    safety::audit::MemoryAudit,
    server::{
        lan::LanState,
        pairing::PairingStore,
        ws::{Server, ServerConfig},
    },
};
use futures_util::{SinkExt, StreamExt};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_tungstenite::{
    client_async, connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Error as WsError, Message},
    WebSocketStream,
};

const APP: &str = "http://localhost:3000";

struct Daemon {
    port: u16,
    lan_port: u16,
    pairing: Arc<PairingStore>,
    audit: Arc<MemoryAudit>,
    lan: Arc<LanState>,
    cloud: SigningKey,
    _task: tokio::task::JoinHandle<()>,
}

fn lease(cloud: &SigningKey, user: &str, tier: &str, features: &[&str]) -> String {
    let now = unix_now();
    jws::sign(
        &json!({"aud": "edge-daemon", "tenant_id": "t-1", "user_id": user, "tier": tier,
                "features": features, "nbf": now - 60, "exp": now + 3_600}),
        "cloud-test",
        cloud,
    )
}

async fn start(enabled: bool, tweak: impl FnOnce(&mut LanState)) -> Daemon {
    let cloud = SigningKey::from_bytes(&[11; 32]);
    let keys =
        KeyRing::from_raw([("cloud-test".to_owned(), cloud.verifying_key().to_bytes())]).unwrap();
    let pairing = Arc::new(PairingStore::in_memory());
    let audit = Arc::new(MemoryAudit::default());
    let mut cfg = ServerConfig::new(keys, Arc::clone(&pairing), audit.clone());
    cfg.port = 0;
    // Technician u-1 has a Pro lease on this PC; u-2 has none.
    cfg.user_leases
        .lock()
        .unwrap()
        .insert("u-1".into(), lease(&cloud, "u-1", "PRO", &["UDS_ACTIVE"]));
    let mut lan = if enabled {
        LanState::enabled_in_memory(0).unwrap()
    } else {
        LanState::disabled()
    };
    lan.addresses_override = Some(vec!["127.0.0.1".parse().unwrap()]);
    lan.settings.name = "Bay 3 PC".into();
    tweak(&mut lan);
    cfg.lan = Arc::new(lan);
    let server = Server::bind(cfg).await.unwrap();
    let port = server.port();
    let lan_port = server.lan_port().unwrap_or(0);
    let lan = server.lan_state();
    Daemon {
        port,
        lan_port,
        pairing,
        audit,
        lan,
        cloud,
        _task: tokio::spawn(server.run()),
    }
}

impl Daemon {
    fn pairing_jwt(&self, user: &str, tenant: &str) -> String {
        let now = unix_now();
        jws::sign(
            &json!({"aud": "edge-ws", "user_id": user, "tenant_id": tenant, "origin": APP,
                    "iat": now, "exp": now + 240}),
            "cloud-test",
            &self.cloud,
        )
    }

    /// The PC's browser, signed in as `user`.
    async fn browser(&self, user: &str) -> WebSocketStream<impl AsyncRead + AsyncWrite + Unpin> {
        let mut req = format!("ws://127.0.0.1:{}/", self.port)
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("origin", HeaderValue::from_static(APP));
        let (mut ws, _) = connect_async(req).await.unwrap();
        send(&mut ws, &hello(&self.pairing_jwt(user, "t-1"))).await;
        let h = next(&mut ws).await.unwrap();
        assert_eq!(h["type"], "HelloResponse", "{h}");
        ws
    }
}

fn hello(token: &str) -> Value {
    json!({"type": "HelloRequest", "request_id": "h1", "client_token": token, "client_version": "0.2.0",
           "protocol_version": protocol::PROTOCOL_VERSION, "policy_version": protocol::policy_version()})
}

async fn send<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, v: &Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

async fn next<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>) -> Option<Value> {
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

async fn reply<S: AsyncRead + AsyncWrite + Unpin>(ws: &mut WebSocketStream<S>, id: &str) -> Value {
    loop {
        let msg = next(ws).await.expect("connection open");
        if msg["request_id"] == id {
            return msg;
        }
    }
}

// --- The phone side: TLS pinned to the fingerprint from the QR code. -------

#[derive(Debug)]
struct Pinned {
    sha256_hex: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got: String = Sha256::digest(end_entity.as_ref())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if got == self.sha256_hex {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("certificate pin mismatch".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

type PhoneWs = WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;

#[derive(Debug)]
#[allow(dead_code)] // read through Debug in assertion messages
enum PhoneError {
    Tls(std::io::Error),
    Ws(WsError),
}

struct Phone<'a> {
    host: &'a str,
    port: u16,
    fingerprint: &'a str,
    origin: Option<&'a str>,
    authorization: Option<String>,
    host_header: Option<&'a str>,
}

impl Phone<'_> {
    async fn connect(&self) -> Result<PhoneWs, PhoneError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pinned {
                sha256_hex: self.fingerprint.to_owned(),
                provider,
            }))
            .with_no_client_auth();
        let tcp = TcpStream::connect((self.host, self.port))
            .await
            .map_err(PhoneError::Tls)?;
        let ip: IpAddr = self.host.parse().unwrap();
        let stream = tokio_rustls::TlsConnector::from(Arc::new(tls))
            .connect(ServerName::IpAddress(ip.into()), tcp)
            .await
            .map_err(PhoneError::Tls)?;
        let mut req = format!("wss://{}:{}/", self.host, self.port)
            .into_client_request()
            .unwrap();
        if let Some(h) = self.host_header {
            req.headers_mut()
                .insert("host", HeaderValue::from_str(h).unwrap());
        }
        if let Some(o) = self.origin {
            req.headers_mut()
                .insert("origin", HeaderValue::from_str(o).unwrap());
        }
        if let Some(a) = &self.authorization {
            req.headers_mut()
                .insert("authorization", HeaderValue::from_str(a).unwrap());
        }
        client_async(req, stream)
            .await
            .map(|(ws, _)| ws)
            .map_err(PhoneError::Ws)
    }
}

fn http_status(e: &PhoneError) -> Option<u16> {
    match e {
        PhoneError::Ws(WsError::Http(resp)) => Some(resp.status().as_u16()),
        _ => None,
    }
}

/// Fields of the rootcause://lan-pair link.
fn link_field<'a>(uri: &'a str, key: &str) -> &'a str {
    uri.split_once('?')
        .unwrap()
        .1
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{key}=")))
        .unwrap()
}

struct Paired {
    fingerprint: String,
    credential: String,
    device_id: String,
}

/// The whole pairing: QR code on the PC, pairing connection from the phone.
async fn pair_phone(d: &Daemon, browser_user: &str) -> Paired {
    let mut pc = d.browser(browser_user).await;
    send(
        &mut pc,
        &json!({"type": "LanPairOfferRequest", "request_id": "o1", "host": null}),
    )
    .await;
    let offer = reply(&mut pc, "o1").await;
    assert_eq!(offer["type"], "LanPairOffer", "{offer}");
    let uri = offer["pairing_uri"].as_str().unwrap();
    assert_eq!(link_field(uri, "h"), "127.0.0.1");
    assert_eq!(link_field(uri, "p"), d.lan_port.to_string());
    assert_eq!(link_field(uri, "n"), "Bay%203%20PC");
    assert!(offer["qr_rows"].as_array().unwrap().len() >= 21);
    let fingerprint = link_field(uri, "fp").to_owned();
    assert_eq!(offer["fingerprint"], fingerprint.as_str());
    let token = link_field(uri, "t");

    let mut ws = Phone {
        host: "127.0.0.1",
        port: d.lan_port,
        fingerprint: &fingerprint,
        origin: Some(APP),
        authorization: Some(format!("RootCause-Pair {token}")),
        host_header: None,
    }
    .connect()
    .await
    .unwrap();
    send(&mut ws, &json!({"type": "LanPairRequest", "request_id": "p1", "device_name": "Pixel 8", "client_version": "0.2.0"})).await;
    let resp = next(&mut ws).await.unwrap();
    assert_eq!(resp["type"], "LanPairResponse", "{resp}");
    assert_eq!(resp["daemon_id"], link_field(uri, "id"));
    assert!(next(&mut ws).await.is_none(), "pairing connection closes");
    let device_id = resp["device_id"].as_str().unwrap().to_owned();
    Paired {
        credential: format!("{device_id}.{}", resp["device_secret"].as_str().unwrap()),
        fingerprint,
        device_id,
    }
}

fn phone<'a>(d: &Daemon, p: &'a Paired) -> Phone<'a> {
    Phone {
        host: "127.0.0.1",
        port: d.lan_port,
        fingerprint: &p.fingerprint,
        origin: Some(APP),
        authorization: Some(format!("Bearer {}", p.credential)),
        host_header: None,
    }
}

#[tokio::test]
async fn phone_access_is_off_by_default() {
    let d = start(false, |_| {}).await;
    assert_eq!(d.lan_port, 0, "no network listener");
    let mut pc = d.browser("u-1").await;
    send(
        &mut pc,
        &json!({"type": "LanStatusRequest", "request_id": "s1"}),
    )
    .await;
    let s = reply(&mut pc, "s1").await;
    assert_eq!(s["type"], "LanStatus", "{s}");
    assert_eq!(s["enabled"], false);
    assert_eq!(s["fingerprint"], Value::Null);
    assert_eq!(s["addresses"], json!([]));
    send(
        &mut pc,
        &json!({"type": "LanPairOfferRequest", "request_id": "o1", "host": null}),
    )
    .await;
    let o = reply(&mut pc, "o1").await;
    assert_eq!(o["code"], "LAN_UNAVAILABLE", "{o}");
}

#[tokio::test]
async fn phone_pairs_over_tls_and_clears_codes_through_the_interlock() {
    let d = start(true, |_| {}).await;
    assert_ne!(d.lan_port, 0);
    let mut pc = d.browser("u-1").await;
    send(
        &mut pc,
        &json!({"type": "LanStatusRequest", "request_id": "s1"}),
    )
    .await;
    let s = reply(&mut pc, "s1").await;
    assert_eq!(
        (s["enabled"].as_bool(), s["port"].as_u64()),
        (Some(true), Some(u64::from(d.lan_port)))
    );
    assert_eq!(s["addresses"], json!(["127.0.0.1"]));
    assert_eq!(s["daemon_name"], "Bay 3 PC");

    let p = pair_phone(&d, "u-1").await;
    assert_eq!(s["fingerprint"], p.fingerprint.as_str());

    // Technician u-1 on the phone runs under u-1's own lease...
    let mut ws = phone(&d, &p).connect().await.unwrap();
    send(&mut ws, &hello(&d.pairing_jwt("u-1", "t-1"))).await;
    let h = next(&mut ws).await.unwrap();
    assert_eq!(h["type"], "HelloResponse", "{h}");
    assert_eq!(h["lease_tier"], "PRO");

    // ...and u-2 on the same phone gets nothing of u-1's.
    let mut other = phone(&d, &p).connect().await.unwrap();
    send(&mut other, &hello(&d.pairing_jwt("u-2", "t-1"))).await;
    assert_eq!(next(&mut other).await.unwrap()["lease_tier"], "COMMUNITY");
    drop(other);

    // The PC sees the phone connected.
    send(
        &mut pc,
        &json!({"type": "LanStatusRequest", "request_id": "s2"}),
    )
    .await;
    let s = reply(&mut pc, "s2").await;
    let dev = &s["devices"][0];
    assert_eq!(
        (dev["name"].as_str(), dev["connected"].as_bool()),
        (Some("Pixel 8"), Some(true)),
        "{s}"
    );
    assert_eq!(dev["paired_by"], "u-1");

    // A car write: refused without a safety token, done with one.
    send(&mut ws, &json!({"type": "ConnectRequest", "request_id": "c1", "adapter_id": "virtual-generic-uds",
                          "protocol": "AUTO", "baud_rate": null, "safety_mode": "ACTIVE_CONFIRMED"})).await;
    assert_eq!(reply(&mut ws, "c1").await["state"], "CONNECTED");
    tokio::time::sleep(Duration::from_millis(400)).await; // live speed for the interlock
    let clear = |id: &str, token: Value| {
        json!({"type": "DiagCommandRequest", "request_id": id, "tx_id": 0x7E0,
        "rx_id": 0x7E8, "protocol": "UDS", "service_id": 0x14, "payload_hex": "14FFFFFF", "safety_token": token})
    };
    send(&mut ws, &clear("x0", Value::Null)).await;
    let refused = reply(&mut ws, "x0").await;
    assert_eq!(refused["code"], "TOKEN_INVALID", "{refused}");
    send(
        &mut ws,
        &json!({"type": "SafetyConfirmRequest", "request_id": "t1", "tx_id": 0x7E0, "rx_id": 0x7E8,
        "protocol": "UDS", "service_id": 0x14, "payload_hex": "14FFFFFF",
        "user_ack_text": "Clear codes on ENGINE; technician confirmed on the phone"}),
    )
    .await;
    let grant = reply(&mut ws, "t1").await;
    assert_eq!(grant["type"], "SafetyConfirmResponse", "{grant}");
    send(&mut ws, &clear("x1", grant["safety_token"].clone())).await;
    let done = reply(&mut ws, "x1").await;
    assert_eq!(done["positive"], true, "{done}");
    let client = format!("lan:{} (Pixel 8)", p.device_id);
    let entries = d.audit.entries();
    assert!(
        entries
            .iter()
            .any(|e| e.client.as_deref() == Some(client.as_str())
                && e.user.as_deref() == Some("u-1")
                && e.service.contains("0x14")),
        "the audit log names the phone and the technician: {entries:#?}"
    );

    // Phones can't manage phone access.
    send(
        &mut ws,
        &json!({"type": "LanPairOfferRequest", "request_id": "o9", "host": null}),
    )
    .await;
    assert_eq!(reply(&mut ws, "o9").await["code"], "LAN_UNAVAILABLE");
    send(
        &mut ws,
        &json!({"type": "LanDeviceRevokeRequest", "request_id": "r9", "device_id": p.device_id}),
    )
    .await;
    assert_eq!(reply(&mut ws, "r9").await["code"], "LAN_UNAVAILABLE");

    // Revoking from the PC closes the phone's socket at once.
    send(
        &mut pc,
        &json!({"type": "LanDeviceRevokeRequest", "request_id": "r1", "device_id": p.device_id}),
    )
    .await;
    let s = reply(&mut pc, "r1").await;
    assert_eq!(s["devices"], json!([]), "{s}");
    let bye = loop {
        let m = next(&mut ws)
            .await
            .expect("an ErrorResponse before closing");
        if m["type"] == "ErrorResponse" {
            break m;
        }
    };
    assert_eq!(bye["code"], "UNAUTHENTICATED", "{bye}");
    assert!(bye["message"].as_str().unwrap().contains("removed"));
    let again = phone(&d, &p).connect().await.unwrap_err();
    assert_eq!(http_status(&again), Some(401), "{again:?}");
}

#[tokio::test]
async fn pairing_codes_work_once_and_pins_must_match() {
    let d = start(true, |_| {}).await;
    let mut pc = d.browser("u-1").await;
    send(
        &mut pc,
        &json!({"type": "LanPairOfferRequest", "request_id": "o1", "host": null}),
    )
    .await;
    let offer = reply(&mut pc, "o1").await;
    let uri = offer["pairing_uri"].as_str().unwrap().to_owned();
    let fp = link_field(&uri, "fp").to_owned();
    let token = link_field(&uri, "t").to_owned();

    // A phone pinned to some other certificate never completes TLS.
    let wrong = "0".repeat(64);
    let e = Phone {
        host: "127.0.0.1",
        port: d.lan_port,
        fingerprint: &wrong,
        origin: Some(APP),
        authorization: Some(format!("RootCause-Pair {token}")),
        host_header: None,
    }
    .connect()
    .await
    .unwrap_err();
    assert!(matches!(e, PhoneError::Tls(_)), "{e:?}");

    let pairing = |token: String| Phone {
        host: "127.0.0.1",
        port: d.lan_port,
        fingerprint: &fp,
        origin: Some(APP),
        authorization: Some(format!("RootCause-Pair {token}")),
        host_header: None,
    };
    for (i, expect) in [(1, "LanPairResponse"), (2, "ErrorResponse")] {
        let mut ws = pairing(token.clone()).connect().await.unwrap();
        send(&mut ws, &json!({"type": "LanPairRequest", "request_id": format!("p{i}"), "device_name": "Phone", "client_version": "0.2.0"})).await;
        let r = next(&mut ws).await.unwrap();
        assert_eq!(r["type"], expect, "attempt {i}: {r}");
        if expect == "ErrorResponse" {
            assert_eq!(r["code"], "UNAUTHENTICATED");
        }
    }
    // A pairing connection carries nothing else.
    let mut pc2 = d.browser("u-1").await;
    send(
        &mut pc2,
        &json!({"type": "LanPairOfferRequest", "request_id": "o2", "host": null}),
    )
    .await;
    let fresh = reply(&mut pc2, "o2").await;
    let t2 = link_field(fresh["pairing_uri"].as_str().unwrap(), "t").to_owned();
    let mut ws = pairing(t2).connect().await.unwrap();
    send(&mut ws, &hello(&d.pairing_jwt("u-1", "t-1"))).await;
    assert_eq!(next(&mut ws).await.unwrap()["code"], "UNAUTHENTICATED");
    // Asking for an address that isn't this PC's is refused.
    send(
        &mut pc2,
        &json!({"type": "LanPairOfferRequest", "request_id": "o3", "host": "10.9.9.9"}),
    )
    .await;
    assert_eq!(reply(&mut pc2, "o3").await["type"], "ErrorResponse");
}

#[tokio::test]
async fn network_refusals() {
    let d = start(true, |lan| {
        lan.guard.max_failures = 3;
    })
    .await;
    let p = pair_phone(&d, "u-1").await;

    // No Origin, a foreign Origin, or a DNS name in Host: refused before WebSocket.
    for (origin, host) in [
        (None, None),
        (Some("https://evil.example"), None),
        (Some(APP), Some(format!("evil.example:{}", d.lan_port))),
    ] {
        let mut ph = phone(&d, &p);
        ph.origin = origin;
        ph.host_header = host.as_deref();
        let e = ph.connect().await.unwrap_err();
        assert_eq!(http_status(&e), Some(403), "{origin:?} {host:?}: {e:?}");
    }

    // A six-digit local code is refused over the network.
    let mut ws = phone(&d, &p).connect().await.unwrap();
    let code = d.pairing.issue(unix_now()).unwrap();
    send(&mut ws, &hello(&code)).await;
    let r = next(&mut ws).await.unwrap();
    assert_eq!(r["code"], "UNAUTHENTICATED", "{r}");
    assert!(r["message"]
        .as_str()
        .unwrap()
        .contains("only work on this PC"));
    assert!(
        d.pairing.consume(&code, unix_now()),
        "the code wasn't burnt by the phone"
    );

    // A pairing JWT for another origin fails as in the browser.
    let mut ws = phone(&d, &p).connect().await.unwrap();
    let now = unix_now();
    let foreign = jws::sign(
        &json!({"aud": "edge-ws", "user_id": "u-1", "tenant_id": "t-1", "origin": "https://evil.example", "iat": now, "exp": now + 240}),
        "cloud-test",
        &d.cloud,
    );
    send(&mut ws, &hello(&foreign)).await;
    assert_eq!(next(&mut ws).await.unwrap()["code"], "UNAUTHENTICATED");

    // The phone was paired for workshop t-1 (its creator's); t-2 is refused.
    let mut ws = phone(&d, &p).connect().await.unwrap();
    send(&mut ws, &hello(&d.pairing_jwt("u-9", "t-2"))).await;
    let r = next(&mut ws).await.unwrap();
    assert!(
        r["message"].as_str().unwrap().contains("another workshop"),
        "{r}"
    );

    // Wrong credentials: 401, and after three the address is blocked outright.
    for _ in 0..3 {
        let mut ph = phone(&d, &p);
        ph.authorization = Some(format!("Bearer {}.{}", p.device_id, "A".repeat(43)));
        assert_eq!(http_status(&ph.connect().await.unwrap_err()), Some(401));
    }
    let blocked = phone(&d, &p).connect().await.unwrap_err();
    assert!(
        http_status(&blocked).is_none(),
        "dropped before TLS: {blocked:?}"
    );
    assert_eq!(
        d.lan.registry.list().len(),
        1,
        "the phone itself stays paired"
    );
}

#[tokio::test]
async fn command_line_pairing_binds_the_first_workshop_and_plain_ws_is_refused() {
    let d = start(true, |_| {}).await;
    // `edge-daemon lan pair` makes codes with no user or workshop.
    let offer = d.lan.issue_offer(None, None, None, unix_now()).unwrap();
    let token = link_field(&offer.uri, "t").to_owned();
    let mut ws = Phone {
        host: "127.0.0.1",
        port: d.lan_port,
        fingerprint: &offer.fingerprint,
        origin: Some(APP),
        authorization: Some(format!("RootCause-Pair {token}")),
        host_header: None,
    }
    .connect()
    .await
    .unwrap();
    send(&mut ws, &json!({"type": "LanPairRequest", "request_id": "p1", "device_name": "Galaxy Tab", "client_version": "0.2.0"})).await;
    let resp = next(&mut ws).await.unwrap();
    let id = resp["device_id"].as_str().unwrap().to_owned();
    let p = Paired {
        credential: format!("{id}.{}", resp["device_secret"].as_str().unwrap()),
        fingerprint: offer.fingerprint.clone(),
        device_id: id,
    };
    let mut first = phone(&d, &p).connect().await.unwrap();
    send(&mut first, &hello(&d.pairing_jwt("u-5", "t-5"))).await;
    assert_eq!(next(&mut first).await.unwrap()["type"], "HelloResponse");
    let mut second = phone(&d, &p).connect().await.unwrap();
    send(&mut second, &hello(&d.pairing_jwt("u-6", "t-6"))).await;
    assert_eq!(next(&mut second).await.unwrap()["code"], "UNAUTHENTICATED");
    assert_eq!(
        d.lan
            .registry
            .get(&p.device_id)
            .unwrap()
            .tenant_id
            .as_deref(),
        Some("t-5")
    );

    // Plain ws:// on the phone port gets no WebSocket.
    let mut req = format!("ws://127.0.0.1:{}/", d.lan_port)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("origin", HeaderValue::from_static(APP));
    assert!(
        tokio::time::timeout(Duration::from_secs(8), connect_async(req))
            .await
            .map_or(true, |r| r.is_err())
    );
}
