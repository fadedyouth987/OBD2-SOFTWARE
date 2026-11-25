// Browser demo: an in-page stand-in for the edge daemon, for trying the app
// without the daemon installed. It is opt-in, labelled everywhere it shows,
// and deliberately limited: read-only (COMMUNITY), one fixed demo car, no
// leases, no gated actions. Every frame it sends passes the same schema
// checks (toWire) as the real daemon's.

import { POLICY_VERSION, PROTOCOL_VERSION, parseMessage, toWire } from "@/lib/edge-protocol";
import type { Transport, TransportFactory } from "@/lib/edge-client";
import type { EdgeMessage, ErrorCode } from "@/types/edge-protocol";

export const BROWSER_SIM_ADAPTER_ID = "browser-demo";
export const BROWSER_SIM_VIN = "DEMXBRWSR00000001";
export const BROWSER_SIM_DAEMON_VERSION = "0.0.0";

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/** Fixed demo faults: P0171 confirmed, P0174 pending. */
const CONFIRMED = [0x01, 0x71];
const PENDING = [0x01, 0x74];

export function browserSimTransport(): TransportFactory {
  return (h) => {
    let closed = false;
    let connected = false;
    let ready = false;
    let streamTimer: ReturnType<typeof setInterval> | null = null;
    const t0 = Date.now();

    const emit = (m: EdgeMessage) => {
      if (closed) return;
      const text = toWire(m);
      setTimeout(() => !closed && h.onMessage(text), 5);
    };
    const error = (request_id: string | null, code: ErrorCode, message: string, hint: string) =>
      emit({ type: "ErrorResponse", request_id, code, message, hint, detail_json: null });

    const stopStream = () => {
      if (streamTimer) clearInterval(streamTimer);
      streamTimer = null;
    };
    const startStream = () => {
      stopStream();
      streamTimer = setInterval(() => {
        const s = (Date.now() - t0) / 1000;
        const ts = Date.now() * 1000;
        const rpm = 780 + Math.sin(s / 1.7) * 30 + Math.sin(s * 3.1) * 6;
        emit({
          type: "ObdPidStream",
          samples: [
            { timestamp_us: ts, pid: 0x0c, name: "Engine RPM", value: Math.round(rpm * 4) / 4, unit: "rpm" },
            { timestamp_us: ts, pid: 0x0d, name: "Vehicle speed", value: 0, unit: "km/h" },
            { timestamp_us: ts, pid: 0x05, name: "Coolant temperature", value: Math.min(90, 40 + s * 0.8), unit: "°C" },
            { timestamp_us: ts, pid: 0x0f, name: "Intake air temperature", value: 31, unit: "°C" },
            { timestamp_us: ts, pid: 0x06, name: "Short term fuel trim B1", value: Math.round((9 + Math.sin(s) * 2.5) * 10) / 10, unit: "%" },
            { timestamp_us: ts, pid: 0x07, name: "Long term fuel trim B1", value: 14.1, unit: "%" },
            { timestamp_us: ts, pid: 0x42, name: "Control module voltage", value: Math.round((13.9 + Math.cos(s / 3) * 0.1) * 100) / 100, unit: "V" },
          ],
        });
      }, 100);
    };

    const diag = (m: Extract<EdgeMessage, { type: "DiagCommandRequest" }>) => {
      if (!connected) {
        return error(m.request_id, "ADAPTER_ERROR", "connect an adapter first", "Connect the demo vehicle first.");
      }
      const req = m.payload_hex.toUpperCase();
      const reply = (bytes: number[]) =>
        emit({ type: "DiagCommandResponse", request_id: m.request_id, positive: bytes[0] !== 0x7f, response_hex: hex(bytes), nrc: bytes[0] === 0x7f ? { code: bytes[2], name: bytes[2] === 0x11 ? "serviceNotSupported" : "subFunctionNotSupported" } : null });
      if (m.protocol === "OBD") {
        if (req === "03") return reply([0x43, 0x01, ...CONFIRMED]);
        if (req === "07") return reply([0x47, 0x01, ...PENDING]);
        if (req === "0A") return reply([0x4a, 0x00]);
        if (req === "0902") return reply([0x49, 0x02, 0x01, ...Array.from(BROWSER_SIM_VIN).map((c) => c.charCodeAt(0))]);
        if (req.startsWith("04") || req.startsWith("08")) {
          return error(m.request_id, "SAFETY_BLOCKED", "The browser demo is read-only.", "Connect a real daemon with a Pro lease for gated actions.");
        }
        return reply([0x7f, Number.parseInt(req.slice(0, 2), 16), 0x12]);
      }
      // The demo car has no UDS modules.
      return reply([0x7f, Number.parseInt(req.slice(0, 2), 16), 0x11]);
    };

    const handle = (text: string) => {
      const parsed = parseMessage(text);
      if (!parsed.ok) return error(null, "PROTOCOL_ERROR", parsed.error, "This is a bug in the app.");
      const m = parsed.message;
      if (!ready) {
        if (m.type !== "HelloRequest") return error(null, "UNAUTHENTICATED", "the first message must be HelloRequest", "Reload the page.");
        ready = true;
        return emit({
          type: "HelloResponse",
          request_id: m.request_id,
          session_id: `browserdemo_${t0.toString(36)}`,
          daemon_version: BROWSER_SIM_DAEMON_VERSION,
          protocol_version: PROTOCOL_VERSION,
          policy_version: POLICY_VERSION,
          lease_tier: "COMMUNITY",
          features: [],
        });
      }
      switch (m.type) {
        case "AdapterListRequest":
          return emit({
            type: "AdapterListResponse",
            request_id: m.request_id,
            adapters: [
              { adapter_id: BROWSER_SIM_ADAPTER_ID, kind: "VIRTUAL", display_name: "Browser demo car (not a real vehicle)", path: null },
            ],
          });
        case "ConnectRequest":
          if (m.adapter_id !== BROWSER_SIM_ADAPTER_ID) {
            return error(m.request_id, "ADAPTER_ERROR", `unknown adapter ${m.adapter_id}`, "Pick the demo car.");
          }
          if (m.safety_mode === "ACTIVE_CONFIRMED") {
            return error(m.request_id, "LEASE_REQUIRED", "The browser demo is read-only (Community).", "Use the real daemon with a Pro lease for active mode.");
          }
          connected = true;
          startStream();
          return emit({ type: "AdapterStatus", request_id: m.request_id, adapter_id: m.adapter_id, state: "CONNECTED", battery_v: 12.6 });
        case "DisconnectRequest":
          connected = false;
          stopStream();
          return emit({ type: "AdapterStatus", request_id: m.request_id, adapter_id: m.adapter_id, state: "DISCONNECTED", battery_v: null });
        case "DiagCommandRequest":
          return diag(m);
        case "SafetyConfirmRequest":
          return error(m.request_id, "SAFETY_BLOCKED", "The browser demo is read-only.", "Connect a real daemon with a Pro lease for gated actions.");
        case "LeaseStatusRequest":
          return emit({ type: "LeaseStatus", request_id: m.request_id, lease_tier: "COMMUNITY", features: [], expires_at: null, immo_expires_at: null, cloud_keys_pinned: false });
        case "LeaseInstallRequest":
          return error(m.request_id, "LEASE_REQUIRED", "The browser demo can't install leases.", "Connect the real edge daemon to install a lease.");
        default:
          return error(null, "PROTOCOL_ERROR", `unexpected ${m.type}`, "This is a bug in the app.");
      }
    };

    setTimeout(() => !closed && h.onOpen(), 30);
    const transport: Transport = {
      send: (text) => {
        if (!closed) setTimeout(() => handle(text), 5);
      },
      close: () => {
        if (closed) return;
        closed = true;
        stopStream();
        setTimeout(() => h.onClose(true), 0);
      },
    };
    return transport;
  };
}
