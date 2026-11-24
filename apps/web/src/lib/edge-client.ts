"use client";

export type EdgeConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "daemon_not_running"
  | "origin_blocked"
  | "pairing_rejected";

export interface EdgeClientOptions {
  url?: string;
  pairingToken: string;
  onStateChange?: (state: EdgeConnectionState, hint?: string) => void;
  onMessage?: (payload: Record<string, unknown>) => void;
}

/**
 * Auto-reconnecting loopback WebSocket client for apps/edge-daemon (Task 4.1).
 * Always sends HelloRequest as the very first frame (Rule 4).
 */
export class EdgeClient {
  private ws: WebSocket | null = null;
  private opts: EdgeClientOptions;

  constructor(opts: EdgeClientOptions) {
    this.opts = opts;
  }

  connect(): void {
    const url = this.opts.url ?? "ws://127.0.0.1:8765";
    this.opts.onStateChange?.("connecting");
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.opts.onStateChange?.(
        "origin_blocked",
        "Browser blocked ws://127.0.0.1:8765. Allow local loopback access or check EDGE_ALLOWED_ORIGINS."
      );
      return;
    }

    this.ws.onopen = () => {
      this.ws?.send(
        JSON.stringify({
          type: "HelloRequest",
          request_id: crypto.randomUUID(),
          protocol_version: "1.0.0",
          policy_version: "1.0.0",
          pairing_token: this.opts.pairingToken,
        })
      );
      this.opts.onStateChange?.("connected");
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (msg.error_code === "UNAUTHENTICATED" || msg.code === "UNAUTHENTICATED") {
          this.opts.onStateChange?.("pairing_rejected", "Pairing code expired or invalid. Run `edge-daemon -- pair`.");
          return;
        }
        this.opts.onMessage?.(msg);
      } catch {
        // Ignore malformed frames
      }
    };

    this.ws.onerror = () => {
      this.opts.onStateChange?.(
        "daemon_not_running",
        "Cannot reach local edge daemon on ws://127.0.0.1:8765. Start it with `cargo run -p edge-daemon`."
      );
    };

    this.ws.onclose = () => {
      this.ws = null;
    };
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  listAdapters(): void {
    this.send({ type: "AdapterListRequest", request_id: crypto.randomUUID() });
  }

  connectAdapter(adapterId: string, protocol = "AUTO", safetyMode: "SILENT" | "ACTIVE_CONFIRMED" = "SILENT"): void {
    this.send({
      type: "ConnectRequest",
      request_id: crypto.randomUUID(),
      adapter_id: adapterId,
      protocol,
      baud_rate: null,
      safety_mode: safetyMode,
    });
  }

  disconnectAdapter(adapterId: string): void {
    this.send({
      type: "DisconnectRequest",
      request_id: crypto.randomUUID(),
      adapter_id: adapterId,
    });
  }

  requestSafetyConfirm(params: {
    protocol: string;
    serviceId: number;
    txId: number;
    rxId: number;
    payloadHex: string;
    userAckText: string;
  }): void {
    this.send({
      type: "SafetyConfirmRequest",
      request_id: crypto.randomUUID(),
      protocol: params.protocol,
      service_id: params.serviceId,
      tx_id: params.txId,
      rx_id: params.rxId,
      payload_hex: params.payloadHex,
      user_ack_text: params.userAckText,
    });
  }

  sendDiagCommand(params: {
    protocol: string;
    serviceId: number;
    txId: number;
    rxId: number;
    payloadHex: string;
    safetyToken?: string | null;
  }): void {
    this.send({
      type: "DiagCommandRequest",
      request_id: crypto.randomUUID(),
      protocol: params.protocol,
      service_id: params.serviceId,
      tx_id: params.txId,
      rx_id: params.rxId,
      payload_hex: params.payloadHex,
      safety_token: params.safetyToken ?? null,
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.opts.onStateChange?.("disconnected");
  }
}
