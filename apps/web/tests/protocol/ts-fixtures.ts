// One instance of every message type, typed through the generated Zod types.
// The parity test writes them to packages/schemas/fixtures/ts/ for the Rust side.
// Values deliberately differ from the Rust fixtures (null branches, other enum
// members) so the two sets together cover more of the schema.

import type { EdgeMessage, MessageType } from "../../src/types/edge-protocol";
import { PROTOCOL_VERSION, POLICY_VERSION, errorHint } from "../../src/lib/edge-protocol";

type Fixtures = { [K in MessageType]: Extract<EdgeMessage, { type: K }> };

export const tsFixtures: Fixtures = {
  HelloRequest: {
    type: "HelloRequest",
    request_id: "web_01",
    client_token: "eyJhbGciOiJFZERTQSIsImtpZCI6ImRldi0xIn0.eyJhdWQiOiJlZGdlLXdzIn0.c2ln",
    client_version: "0.1.0",
    protocol_version: PROTOCOL_VERSION,
    policy_version: POLICY_VERSION,
  },
  HelloResponse: {
    type: "HelloResponse",
    request_id: "web_01",
    session_id: "sess-0001",
    daemon_version: "0.1.0",
    protocol_version: PROTOCOL_VERSION,
    policy_version: POLICY_VERSION,
    lease_tier: "COMMUNITY",
    features: [],
  },
  AdapterListRequest: { type: "AdapterListRequest", request_id: "web_02" },
  AdapterListResponse: {
    type: "AdapterListResponse",
    request_id: "web_02",
    adapters: [
      { adapter_id: "j2534-0", kind: "J2534", display_name: "Mongoose Pro", path: "C:\\Windows\\SysWOW64\\mongoose.dll" },
      { adapter_id: "can0", kind: "SOCKETCAN", display_name: "can0", path: "can0" },
    ],
  },
  ConnectRequest: {
    type: "ConnectRequest",
    request_id: "web_03",
    adapter_id: "j2534-0",
    protocol: "BMW_DCAN",
    baud_rate: null,
    safety_mode: "ACTIVE_CONFIRMED",
  },
  DisconnectRequest: { type: "DisconnectRequest", request_id: "web_04", adapter_id: "j2534-0" },
  AdapterStatus: {
    type: "AdapterStatus",
    request_id: "web_03",
    adapter_id: "j2534-0",
    state: "ERROR",
    battery_v: null,
  },
  CanFrameBatch: {
    type: "CanFrameBatch",
    frames: [{ timestamp_us: 0, can_id: 0, is_extended: false, dlc: 0, data_hex: "" }],
  },
  ObdPidStream: {
    type: "ObdPidStream",
    samples: [
      { timestamp_us: 1795000000001000, pid: 5, name: "Coolant temp", value: -12.5, unit: "°C" },
      { timestamp_us: 1795000000001000, pid: 13, name: "Vehicle speed", value: 0, unit: "km/h" },
    ],
  },
  SafetyConfirmRequest: {
    type: "SafetyConfirmRequest",
    request_id: "web_05",
    tx_id: 0x6f1,
    rx_id: 0x612,
    protocol: "KWP2000",
    service_id: 0x14,
    payload_hex: "14FFFF",
    user_ack_text: "Clear all fault memory on the DSC. Stored freeze-frame data will be lost.",
  },
  SafetyConfirmResponse: {
    type: "SafetyConfirmResponse",
    request_id: "web_05",
    safety_token: "st_aaaaaaaaaaaaaaaa",
    expires_at: "2026-11-19T06:16:58.250Z",
    preconditions: { speed_kmh: null, speed_age_ms: null, rpm: null, battery_v: 11.9 },
  },
  DiagCommandRequest: {
    type: "DiagCommandRequest",
    request_id: "web_06",
    tx_id: 0x7df,
    rx_id: 0x7e8,
    protocol: "OBD",
    service_id: 0x01,
    payload_hex: "010C",
    safety_token: null,
  },
  DiagCommandResponse: {
    type: "DiagCommandResponse",
    request_id: "web_06",
    positive: true,
    response_hex: "410C0CB2",
    nrc: null,
  },
  HeuristicAlert: {
    type: "HeuristicAlert",
    rule_id: "audit.vin_mismatch",
    severity: "RED",
    title: "VIN differs between DME and CAS",
    evidence_json: { dme: "WBAVB11060PT00001", cas: "WBAVB11060PT99999" },
    recommended_test: "",
  },
  ErrorResponse: {
    type: "ErrorResponse",
    request_id: null,
    code: "VERSION_UNSUPPORTED",
    message: "Protocol 2.0.0 is not supported by this daemon (1.x).",
    hint: errorHint("VERSION_UNSUPPORTED"),
    detail_json: null,
  },
  LeaseStatusRequest: {
    type: "LeaseStatusRequest",
    request_id: "web_07",
  },
  LeaseInstallRequest: {
    type: "LeaseInstallRequest",
    request_id: "web_08",
    kind: "DIAGNOSTIC",
    lease_token: "eyJhbGciOiJFZERTQSJ9.eyJ0aWVyIjoiV09SS1NIT1AifQ.c2ln",
  },
  LeaseStatus: {
    type: "LeaseStatus",
    request_id: "web_08",
    lease_tier: "WORKSHOP",
    features: ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"],
    expires_at: "2026-11-25T14:00:00Z",
    immo_expires_at: null,
    cloud_keys_pinned: true,
  },
  LanStatusRequest: { type: "LanStatusRequest", request_id: "web_09" },
  LanStatus: {
    type: "LanStatus",
    request_id: "web_09",
    enabled: false,
    port: 8766,
    addresses: [],
    fingerprint: null,
    daemon_id: null,
    daemon_name: "RootCause PC",
    mdns: false,
    devices: [
      {
        device_id: "lan_0011223344556677",
        name: "Galaxy Tab",
        paired_at: "2026-11-20T01:00:00Z",
        last_seen_at: null,
        paired_by: null,
        connected: false,
      },
    ],
  },
  LanPairOfferRequest: { type: "LanPairOfferRequest", request_id: "web_10", host: "10.0.0.5" },
  LanPairOffer: {
    type: "LanPairOffer",
    request_id: "web_10",
    pairing_uri: "rootcause://lan-pair?v=1&h=10.0.0.5&p=9000",
    host: "10.0.0.5",
    port: 9000,
    fingerprint: "cd".repeat(32),
    expires_at: "2026-11-20T01:05:00Z",
    qr_rows: Array.from({ length: 21 }, (_, i) => (i % 2 ? "0" : "1").repeat(21)),
  },
  LanDeviceRevokeRequest: { type: "LanDeviceRevokeRequest", request_id: "web_11", device_id: "lan_0011223344556677" },
  LanPairRequest: { type: "LanPairRequest", request_id: "web_12", device_name: "Galaxy Tab", client_version: "0.2.0" },
  LanPairResponse: {
    type: "LanPairResponse",
    request_id: "web_12",
    device_id: "lan_0011223344556677",
    device_secret: "A_-".repeat(14) + "z",
    daemon_id: "rcd_ffeeddccbbaa9988",
    daemon_name: "RootCause PC",
  },
};
