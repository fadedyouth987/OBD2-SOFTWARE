//! Task 0.2 verification gate, Rust side.
//!
//! - Every message type, built as typed Rust values, serializes to the checked-in
//!   fixtures in `packages/schemas/fixtures/rust/` (the web app's tests parse them
//!   with Zod). Run with `UPDATE_FIXTURES=1` to rewrite them after a schema change.
//! - Every fixture the web app built (`fixtures/ts/`) parses here and round-trips.
//! - Every case in `fixtures/invalid.json` is rejected here, as it is in Zod.
//! - Every request has a response type; any request can get `ErrorResponse`.
//! - The gated set matches `fixtures/gated_set.txt`, which the web app checks too.
//! - Every error code has a one-line hint; version compatibility matches the shared table.

use std::{collections::BTreeSet, fmt::Debug, fs, path::PathBuf, str::FromStr};

use edge_daemon::protocol::{self, messages::*};
use serde_json::{json, Value};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/schemas/fixtures")
}

fn p<T: FromStr>(s: &str) -> T
where
    T::Err: Debug,
{
    s.parse().unwrap_or_else(|e| panic!("{s:?}: {e:?}"))
}

fn object(value: Value) -> serde_json::Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

/// One instance of every message type, built through the generated Rust types.
fn rust_messages() -> Vec<EdgeMessage> {
    let request_id: RequestId = p("req-1");
    vec![
        HelloRequest {
            client_token: p("482913"),
            client_version: p("0.1.0"),
            policy_version: p(protocol::policy_version()),
            protocol_version: p(PROTOCOL_VERSION),
            request_id: request_id.clone(),
            type_: HelloRequestType::HelloRequest,
        }
        .into(),
        HelloResponse {
            daemon_version: p("0.1.0"),
            features: vec![p("J2534"), p("UDS_ACTIVE")],
            lease_tier: p("WORKSHOP"),
            policy_version: p(protocol::policy_version()),
            protocol_version: p(PROTOCOL_VERSION),
            request_id: request_id.clone(),
            session_id: p("sess-7f3a"),
            type_: HelloResponseType::HelloResponse,
        }
        .into(),
        AdapterListRequest {
            request_id: request_id.clone(),
            type_: AdapterListRequestType::AdapterListRequest,
        }
        .into(),
        AdapterListResponse {
            adapters: vec![
                AdapterInfo {
                    adapter_id: p("virtual-e90"),
                    display_name: p("Virtual BMW E90 (pre-03/2007)"),
                    kind: p("VIRTUAL"),
                    path: None,
                },
                AdapterInfo {
                    adapter_id: p("stn2120-ttyUSB0"),
                    display_name: p("OBDLink EX (STN2120)"),
                    kind: p("STN_ELM"),
                    path: Some(p("/dev/ttyUSB0")),
                },
            ],
            request_id: request_id.clone(),
            type_: AdapterListResponseType::AdapterListResponse,
        }
        .into(),
        ConnectRequest {
            adapter_id: p("virtual-e90"),
            baud_rate: Some(std::num::NonZeroU32::new(500_000).unwrap()),
            protocol: p("ISO15765_11_500"),
            request_id: request_id.clone(),
            safety_mode: p("SILENT"),
            type_: ConnectRequestType::ConnectRequest,
        }
        .into(),
        DisconnectRequest {
            adapter_id: p("virtual-e90"),
            request_id: request_id.clone(),
            type_: DisconnectRequestType::DisconnectRequest,
        }
        .into(),
        AdapterStatus {
            adapter_id: p("virtual-e90"),
            battery_v: Some(12.6),
            request_id: None,
            state: p("CONNECTED"),
            type_: AdapterStatusType::AdapterStatus,
        }
        .into(),
        CanFrameBatch {
            frames: vec![
                CanFrame {
                    can_id: CanId(0x7E8),
                    data_hex: p("0441"),
                    dlc: 2,
                    is_extended: false,
                    timestamp_us: TimestampUs(1_795_000_000_000_000),
                },
                CanFrame {
                    can_id: CanId(0x18DA_F110),
                    data_hex: p("0262F190AABBCCDD"),
                    dlc: 8,
                    is_extended: true,
                    timestamp_us: TimestampUs(1_795_000_000_000_250),
                },
            ],
            type_: CanFrameBatchType::CanFrameBatch,
        }
        .into(),
        ObdPidStream {
            samples: vec![PidSample {
                name: p("Engine RPM"),
                pid: 0x0C,
                timestamp_us: TimestampUs(1_795_000_000_000_000),
                unit: p("rpm"),
                value: 812.5,
            }],
            type_: ObdPidStreamType::ObdPidStream,
        }
        .into(),
        SafetyConfirmRequest {
            payload_hex: p("2F0B2A0301"),
            protocol: p("UDS"),
            request_id: request_id.clone(),
            rx_id: CanId(0x7E8),
            service_id: ServiceId(0x2F),
            tx_id: CanId(0x7E0),
            type_: SafetyConfirmRequestType::SafetyConfirmRequest,
            user_ack_text: p(
                "Run the idle-speed actuator test on the DME. The engine speed will change.",
            ),
        }
        .into(),
        SafetyConfirmResponse {
            expires_at: p("2026-11-19T06:16:58Z"),
            preconditions: Preconditions {
                battery_v: Some(12.6),
                rpm: Some(0.0),
                speed_age_ms: Some(140),
                speed_kmh: Some(0.0),
            },
            request_id: request_id.clone(),
            safety_token: p("st_6f1c2a9e0b7d4c35"),
            type_: SafetyConfirmResponseType::SafetyConfirmResponse,
        }
        .into(),
        DiagCommandRequest {
            payload_hex: p("2F0B2A0301"),
            protocol: p("UDS"),
            request_id: request_id.clone(),
            rx_id: CanId(0x7E8),
            safety_token: Some(p("st_6f1c2a9e0b7d4c35")),
            service_id: ServiceId(0x2F),
            tx_id: CanId(0x7E0),
            type_: DiagCommandRequestType::DiagCommandRequest,
        }
        .into(),
        DiagCommandResponse {
            nrc: Some(Nrc {
                code: 0x35,
                name: p("invalidKey"),
            }),
            positive: false,
            request_id: request_id.clone(),
            response_hex: p("7F2735"),
            type_: DiagCommandResponseType::DiagCommandResponse,
        }
        .into(),
        HeuristicAlert {
            evidence_json: object(json!({
                "idle": { "stft_pct": 9.4, "ltft_pct": 6.3 },
                "rpm_2500": { "stft_pct": 1.2, "ltft_pct": 2.0 }
            })),
            recommended_test: p("Smoke-test the intake between the MAF and the throttle body."),
            rule_id: p("fuel_trim.vacuum_leak"),
            severity: p("AMBER"),
            title: p("Lean at idle, normal under load: likely vacuum leak"),
            type_: HeuristicAlertType::HeuristicAlert,
        }
        .into(),
        protocol::error_response(
            Some(request_id.clone()),
            ErrorCode::SafetyBlocked,
            "0x2F InputOutputControlByIdentifier is gated; the session is SILENT.",
            Some(object(json!({ "service_id": 47, "tier": "A" }))),
        )
        .into(),
        LeaseStatusRequest {
            request_id: request_id.clone(),
            type_: LeaseStatusRequestType::LeaseStatusRequest,
        }
        .into(),
        LeaseInstallRequest {
            kind: LeaseKind::Diagnostic,
            lease_token: p("eyJhbGciOiJFZERTQSJ9.eyJ0aWVyIjoiV09SS1NIT1AifQ.c2ln"),
            request_id: request_id.clone(),
            type_: LeaseInstallRequestType::LeaseInstallRequest,
        }
        .into(),
        LeaseStatus {
            cloud_keys_pinned: true,
            expires_at: Some(p("2026-11-25T14:00:00Z")),
            features: vec![p("UDS_ACTIVE"), p("CAN_RE_PRO")],
            immo_expires_at: None,
            lease_tier: p("WORKSHOP"),
            request_id: request_id.clone(),
            type_: LeaseStatusType::LeaseStatus,
        }
        .into(),
        LanStatusRequest {
            request_id: request_id.clone(),
            type_: LanStatusRequestType::LanStatusRequest,
        }
        .into(),
        LanStatus {
            addresses: vec![p("192.168.1.20")],
            daemon_id: Some(p("rcd_0123456789abcdef")),
            daemon_name: p("Bay 3 PC"),
            devices: vec![LanDevice {
                connected: true,
                device_id: p("lan_fedcba9876543210"),
                last_seen_at: Some(p("2026-11-29T01:00:00Z")),
                name: p("Pixel 8"),
                paired_at: p("2026-11-28T23:00:00Z"),
                paired_by: Some(p("u-1")),
            }],
            enabled: true,
            fingerprint: Some(p(&"ab".repeat(32))),
            mdns: false,
            port: std::num::NonZeroU16::new(8766).unwrap(),
            request_id: request_id.clone(),
            type_: LanStatusType::LanStatus,
        }
        .into(),
        LanPairOfferRequest {
            host: None,
            request_id: request_id.clone(),
            type_: LanPairOfferRequestType::LanPairOfferRequest,
        }
        .into(),
        LanPairOffer {
            expires_at: p("2026-11-29T01:05:00Z"),
            fingerprint: p(&"ab".repeat(32)),
            host: p("192.168.1.20"),
            pairing_uri: p("rootcause://lan-pair?v=1&h=192.168.1.20&p=8766"),
            port: std::num::NonZeroU16::new(8766).unwrap(),
            qr_rows: (0..21)
                .map(|_| p(&format!("{}1", "10".repeat(10))))
                .collect(),
            request_id: request_id.clone(),
            type_: LanPairOfferType::LanPairOffer,
        }
        .into(),
        LanDeviceRevokeRequest {
            device_id: p("lan_fedcba9876543210"),
            request_id: request_id.clone(),
            type_: LanDeviceRevokeRequestType::LanDeviceRevokeRequest,
        }
        .into(),
        LanPairRequest {
            client_version: p("0.2.0"),
            device_name: p("Pixel 8"),
            request_id: request_id.clone(),
            type_: LanPairRequestType::LanPairRequest,
        }
        .into(),
        LanPairResponse {
            daemon_id: p("rcd_0123456789abcdef"),
            daemon_name: p("Bay 3 PC"),
            device_id: p("lan_fedcba9876543210"),
            device_secret: p(&"s".repeat(43)),
            request_id: request_id.clone(),
            type_: LanPairResponseType::LanPairResponse,
        }
        .into(),
    ]
}

fn type_name(value: &Value) -> String {
    value["type"]
        .as_str()
        .expect("message has a type")
        .to_owned()
}

fn schema() -> Value {
    serde_json::from_str(protocol::EDGE_WS_SCHEMA_JSON).unwrap()
}

fn schema_message_types() -> BTreeSet<String> {
    schema()["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| {
            v["$ref"]
                .as_str()
                .unwrap()
                .trim_start_matches("#/definitions/")
                .to_owned()
        })
        .collect()
}

/// JSON numbers compared by value: JS writes `0`, serde writes an `f64` zero as `0.0`.
fn numeric(value: &Value) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().expect("finite JSON number")),
        Value::Array(items) => Value::Array(items.iter().map(numeric).collect()),
        Value::Object(map) => {
            Value::Object(map.iter().map(|(k, v)| (k.clone(), numeric(v))).collect())
        }
        other => other.clone(),
    }
}

fn pretty(value: &Value) -> String {
    // serde_json's Map is ordered by key, so output is stable across runs.
    serde_json::to_string_pretty(value).unwrap() + "\n"
}

#[test]
fn rust_fixtures_cover_every_message_and_match_checked_in_files() {
    let dir = fixtures_dir().join("rust");
    let update = std::env::var_os("UPDATE_FIXTURES").is_some();
    let mut seen = BTreeSet::new();
    for message in rust_messages() {
        let wire = protocol::to_wire(&message);
        // What we send must pass our own validator.
        protocol::parse_message(&wire).unwrap_or_else(|e| panic!("{wire}: {e}"));
        let value: Value = serde_json::from_str(&wire).unwrap();
        let name = type_name(&value);
        assert!(seen.insert(name.clone()), "duplicate fixture {name}");
        let path = dir.join(format!("{name}.json"));
        if update {
            fs::write(&path, pretty(&value)).unwrap();
        } else {
            let current = fs::read_to_string(&path)
                .unwrap_or_else(|_| panic!("missing {path:?}; run with UPDATE_FIXTURES=1"));
            assert_eq!(
                current,
                pretty(&value),
                "{path:?} is stale; run with UPDATE_FIXTURES=1"
            );
        }
    }
    assert_eq!(
        seen,
        schema_message_types(),
        "every message type needs a Rust fixture"
    );
}

#[test]
fn ts_fixtures_parse_and_round_trip() {
    let dir = fixtures_dir().join("ts");
    let mut seen = BTreeSet::new();
    for entry in fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let text = fs::read_to_string(&path).unwrap();
        let message = protocol::parse_message(&text)
            .unwrap_or_else(|e| panic!("{path:?} rejected by Rust: {e}"));
        let original: Value = serde_json::from_str(&text).unwrap();
        let round_trip: Value = serde_json::from_str(&protocol::to_wire(&message)).unwrap();
        assert_eq!(
            numeric(&original),
            numeric(&round_trip),
            "{path:?} changed in a Rust round trip"
        );
        seen.insert(type_name(&original));
    }
    assert_eq!(
        seen,
        schema_message_types(),
        "every message type needs a TS fixture"
    );
}

#[test]
fn invalid_fixtures_are_rejected() {
    let text = fs::read_to_string(fixtures_dir().join("invalid.json")).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let wire = case["message"].to_string();
        assert!(
            protocol::parse_message(&wire).is_err(),
            "Rust accepted invalid message ({}): {wire}",
            case["why"]
        );
    }
}

#[test]
fn every_request_has_a_response_and_can_fail() {
    let schema = schema();
    let types = schema_message_types();
    let requests: BTreeSet<String> = types
        .iter()
        .filter(|t| t.ends_with("Request"))
        .cloned()
        .collect();
    let mapped: BTreeSet<String> = REQUEST_RESPONSE
        .iter()
        .map(|(req, _)| req.to_string())
        .collect();
    assert_eq!(
        requests, mapped,
        "every *Request needs an x-request-response entry"
    );
    for (req, resp) in REQUEST_RESPONSE {
        assert!(types.contains(*resp), "{req} maps to unknown {resp}");
        let required = schema["definitions"][*req]["required"].as_array().unwrap();
        assert!(
            required.contains(&json!("request_id")),
            "{req} must carry request_id"
        );
        let resp_props = &schema["definitions"][*resp]["properties"];
        assert!(
            resp_props.get("request_id").is_some(),
            "{resp} must echo request_id"
        );
    }
    assert!(schema["definitions"]["ErrorResponse"]["properties"]
        .get("request_id")
        .is_some());
}

#[test]
fn gated_set_matches_shared_golden_file() {
    let path = fixtures_dir().join("gated_set.txt");
    let fresh = protocol::gated_set_canonical().join("\n") + "\n";
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        fs::write(&path, &fresh).unwrap();
    }
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        fresh,
        "gated set drifted from {path:?}"
    );
}

#[test]
fn every_error_code_has_a_one_line_hint() {
    let schema = schema();
    let codes = schema["definitions"]["ErrorCode"]["enum"]
        .as_array()
        .unwrap();
    let hints: serde_json::Map<String, Value> =
        serde_json::from_str(protocol::ERROR_HINTS_JSON).unwrap();
    assert_eq!(
        codes.len(),
        hints.len(),
        "error_hints.json must have exactly one hint per code"
    );
    for code in codes {
        let code: ErrorCode = serde_json::from_value(code.clone()).unwrap();
        let hint = protocol::error_hint(code);
        assert!(hints.contains_key(&code.to_string()), "no hint for {code}");
        assert!(
            !hint.is_empty() && hint.len() <= 200 && !hint.contains('\n'),
            "{code}: {hint:?}"
        );
    }
}

#[test]
fn version_compatibility_matches_shared_table_both_ways() {
    let text = fs::read_to_string(fixtures_dir().join("version_compat.json")).unwrap();
    let cases: Vec<Value> = serde_json::from_str(&text).unwrap();
    for case in cases {
        let (ours, theirs) = (
            case["ours"].as_str().unwrap(),
            case["theirs"].as_str().unwrap(),
        );
        let expected = case["compatible"].as_bool().unwrap();
        assert_eq!(
            protocol::versions_compatible(ours, theirs),
            expected,
            "{ours} vs {theirs}"
        );
        assert_eq!(
            protocol::versions_compatible(theirs, ours),
            expected,
            "{theirs} vs {ours}"
        );
    }
}
