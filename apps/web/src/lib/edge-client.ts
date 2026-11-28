// Loopback WebSocket client for the edge daemon (Task 4.1, audit H1/H2/M11).
//
// - Every frame is built with toWire() and parsed with parseMessage(), so the
//   generated schema is the contract on both ends.
// - "ready" means HelloResponse arrived, not merely that the socket opened.
// - A dropped daemon is noticed (onclose) and retried with backoff; failures
//   carry the daemon's error code and its one-line fix-it hint.

import {
  PROTOCOL_VERSION,
  POLICY_VERSION,
  errorHint,
  parseMessage,
  toWire,
  versionsCompatible,
} from "@/lib/edge-protocol";
import {
  REQUEST_RESPONSE,
  type EdgeMessage,
  type ErrorCode,
  type HelloResponse,
  type MessageType,
} from "@/types/edge-protocol";

type RequestMap = typeof REQUEST_RESPONSE;
export type RequestType = keyof RequestMap;
type Msg<T extends MessageType> = Extract<EdgeMessage, { type: T }>;
export type RequestOf<T extends RequestType> = Omit<Msg<T>, "request_id">;
export type ResponseOf<T extends RequestType> = Msg<RequestMap[T]>;
export type PushType = "AdapterStatus" | "CanFrameBatch" | "ObdPidStream" | "HeuristicAlert" | "ErrorResponse";

export type EdgeMode = "daemon" | "browser-sim";
export type EdgePhase = "idle" | "connecting" | "handshaking" | "ready" | "waiting" | "failed";
/** `phone`: the Android app's link to the workshop PC (pairing, network, identity). */
export type EdgeFailureKind = "unreachable" | "blocked" | "auth" | "version" | "origin" | "protocol" | "phone";
export type AuthMethod = "cloud" | "code" | "sim";

export interface EdgeFailure {
  kind: EdgeFailureKind;
  message: string;
  hint: string;
  code: ErrorCode | null;
  /** The technician has to type a 6-digit code from `edge-daemon pair`. */
  needsCode: boolean;
}

export interface EdgeSnapshot {
  mode: EdgeMode;
  phase: EdgePhase;
  hello: HelloResponse | null;
  failure: EdgeFailure | null;
  /** Milliseconds until the next automatic attempt, while waiting. */
  retryInMs: number | null;
  /** Compatible but different protocol version (e.g. the daemon is newer). */
  versionNote: string | null;
  authMethod: AuthMethod | null;
  /** Times the connection has become ready; lets views re-subscribe. */
  generation: number;
}

export const INITIAL_SNAPSHOT: EdgeSnapshot = {
  mode: "daemon",
  phase: "idle",
  hello: null,
  failure: null,
  retryInMs: null,
  versionNote: null,
  authMethod: null,
  generation: 0,
};

export class EdgeRequestError extends Error {
  readonly code: ErrorCode | "NOT_CONNECTED" | "CLIENT_TIMEOUT" | "BAD_RESPONSE";
  readonly hint: string;
  readonly detail: Record<string, unknown> | null;

  constructor(
    code: EdgeRequestError["code"],
    message: string,
    hint: string,
    detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "EdgeRequestError";
    this.code = code;
    this.hint = hint;
    this.detail = detail;
  }
}

/** A transport that knows why it closed (the app's link to the PC) says so. */
export interface TransportCloseDetail {
  failure: EdgeFailure;
  /** Worth retrying by itself (network), or needs the technician (pairing, identity). */
  retry: boolean;
}

export interface TransportHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  /** `blocked`: the browser refused to open the socket at all (SecurityError). */
  onClose: (wasOpen: boolean, blocked?: boolean, detail?: TransportCloseDetail) => void;
}

export interface Transport {
  send(text: string): void;
  close(): void;
}

export type TransportFactory = (handlers: TransportHandlers) => Transport;

export function webSocketTransport(url: string): TransportFactory {
  return (h) => {
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      // Mixed content (an https page and ws://) or a Content-Security-Policy
      // refusal throws SecurityError here; anything else is treated as down.
      const blocked = e instanceof DOMException && e.name === "SecurityError";
      queueMicrotask(() => h.onClose(false, blocked));
      return { send: () => undefined, close: () => undefined };
    }
    ws.onopen = () => {
      opened = true;
      h.onOpen();
    };
    ws.onmessage = (ev) => h.onMessage(typeof ev.data === "string" ? ev.data : "");
    ws.onclose = () => h.onClose(opened);
    // onerror is always followed by onclose; handled there.
    return {
      send: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      close: () => ws.close(),
    };
  };
}

export interface Credential {
  token: string;
  method: AuthMethod;
}

export interface EdgeClientOptions {
  mode: EdgeMode;
  transport: TransportFactory;
  clientVersion: string;
  /** A fresh credential for each attempt (cloud pairing JWT), or null. */
  credential: () => Promise<Credential | null>;
  onSnapshot: (s: EdgeSnapshot) => void;
  helloTimeoutMs?: number;
  /**
   * Whether the browser itself refuses local connections for this site (for
   * example Chrome's local network access permission set to Block). Asked
   * only when the socket never opened.
   */
  localAccessBlocked?: () => Promise<boolean>;
  /** The Android app reaching the workshop PC over the network (no pairing codes there). */
  phone?: boolean;
}

/** Shown when the browser, not the daemon, stopped the connection. */
export const BLOCKED_FAILURE: EdgeFailure = {
  kind: "blocked",
  code: null,
  needsCode: false,
  message: "Your browser blocked this site from connecting to the edge daemon on this computer.",
  hint:
    "Allow local network access for this site (the icon at the left of the address bar, then Site settings), or turn off the privacy shield or extension blocking it, then retry.",
};

/** How long to wait for the browser's permission answer before assuming no block. */
export const LOCAL_ACCESS_PROBE_MS = 500;

/**
 * Whether Chrome's permission for this page to reach loopback (127.0.0.1) is
 * set to Block. Chrome names it `loopback-network`; versions before the split
 * used one `local-network-access` permission for loopback and LAN. The LAN-only
 * `local-network` permission is not consulted: the daemon is loopback-only.
 */
export async function browserBlocksLocalAccess(): Promise<boolean> {
  const perms = typeof navigator !== "undefined" ? navigator.permissions : undefined;
  if (!perms) return false;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const status = await perms.query({ name } as unknown as PermissionDescriptor);
      return status.state === "denied";
    } catch {
      // Not a permission this browser knows: try the older name.
    }
  }
  return false;
}

/** The probe's answer, or false if it fails or takes longer than `ms`. */
function probeWithin(probe: () => Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    probe()
      .catch(() => false)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      });
  });
}

interface Pending {
  expect: MessageType;
  resolve: (m: EdgeMessage) => void;
  reject: (e: EdgeRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const BACKOFF_MS = [1000, 2000, 5000, 10000];

function newId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID().replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function failureFor(
  code: ErrorCode,
  message: string,
  hint: string,
  method: AuthMethod | null,
  phone = false,
): EdgeFailure {
  if (phone && (code === "UNAUTHENTICATED" || code === "LAN_UNAVAILABLE")) {
    // The PC said why (removed, other workshop, signed out); codes don't apply to phones.
    return {
      kind: "phone",
      code,
      needsCode: false,
      message: `The workshop PC refused this phone: ${message}`,
      hint: "Sign in again in the app, or pair the phone again: Devices on the PC, Pair a phone; then Pair with a PC here.",
    };
  }
  switch (code) {
    case "UNAUTHENTICATED":
      return {
        kind: "auth",
        code,
        needsCode: true,
        message:
          method === "cloud"
            ? "The daemon didn't accept your cloud sign-in. It has no cloud key pinned, so it only takes local pairing codes."
            : "That pairing code was wrong, expired or already used.",
        hint: "Run `edge-daemon pair` on this computer and type the 6-digit code it prints.",
      };
    case "VERSION_UNSUPPORTED":
      return { kind: "version", code, needsCode: false, message, hint };
    case "ORIGIN_REJECTED":
      return { kind: "origin", code, needsCode: false, message, hint };
    default:
      return { kind: "protocol", code, needsCode: false, message, hint };
  }
}

export class EdgeClient {
  private opts: EdgeClientOptions;
  private transport: Transport | null = null;
  private snap: EdgeSnapshot;
  private pending = new Map<string, Pending>();
  private listeners = new Map<PushType, Set<(m: EdgeMessage) => void>>();
  private pendingCode: string | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private helloId: string | null = null;
  private method: AuthMethod | null = null;
  private stopped = true;
  private epoch = 0;

  constructor(opts: EdgeClientOptions) {
    this.opts = opts;
    this.snap = { ...INITIAL_SNAPSHOT, mode: opts.mode };
  }

  get snapshot(): EdgeSnapshot {
    return this.snap;
  }

  /** Starts connecting and keeps the connection up until stop(). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.epoch += 1;
    this.transport?.close();
    this.transport = null;
    this.rejectAll("The connection to the daemon was closed.");
    this.update({ phase: "idle", hello: null, failure: null, retryInMs: null, authMethod: null });
  }

  /** Tries again now (after a failure or while waiting). */
  retry(): void {
    this.attempt = 0;
    this.clearTimers();
    this.epoch += 1;
    this.transport?.close();
    this.transport = null;
    this.stopped = false;
    void this.connect();
  }

  /** Connects with a single-use 6-digit code from `edge-daemon pair`. */
  pairWithCode(code: string): void {
    this.pendingCode = code.trim();
    this.retry();
  }

  on(type: PushType, fn: (m: EdgeMessage) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  request<T extends RequestType>(
    msg: RequestOf<T> & { type: T },
    timeoutMs = 10_000,
  ): Promise<ResponseOf<T>> {
    if (this.snap.phase !== "ready" || !this.transport) {
      return Promise.reject(
        new EdgeRequestError(
          "NOT_CONNECTED",
          "The edge daemon isn't connected.",
          "Open Devices to connect the daemon, then try again.",
        ),
      );
    }
    const request_id = newId();
    const full = { ...msg, request_id } as unknown as EdgeMessage;
    let text: string;
    try {
      text = toWire(full);
    } catch (e) {
      return Promise.reject(
        new EdgeRequestError("BAD_RESPONSE", `Invalid request: ${(e as Error).message}`, "This is a bug in the app."),
      );
    }
    const expect: MessageType = REQUEST_RESPONSE[msg.type];
    return new Promise<ResponseOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(
          new EdgeRequestError(
            "CLIENT_TIMEOUT",
            "The daemon didn't answer in time.",
            errorHint("TIMEOUT"),
          ),
        );
      }, timeoutMs);
      this.pending.set(request_id, {
        expect,
        resolve: resolve as (m: EdgeMessage) => void,
        reject,
        timer,
      });
      this.transport!.send(text);
    });
  }

  // --- internals ------------------------------------------------------------

  private update(patch: Partial<EdgeSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.opts.onSnapshot(this.snap);
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.retryTimer = null;
    this.helloTimer = null;
  }

  private rejectAll(message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new EdgeRequestError("NOT_CONNECTED", message, "Reconnect the daemon and try again."));
    }
    this.pending.clear();
  }

  private scheduleRetry(failure: EdgeFailure | null): void {
    if (this.stopped) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.update({ phase: "waiting", failure, retryInMs: delay, hello: null });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    this.update({ phase: "connecting", retryInMs: null });
    let cred: Credential | null;
    if (this.pendingCode) {
      cred = { token: this.pendingCode, method: "code" };
    } else {
      try {
        cred = await this.opts.credential();
      } catch {
        cred = null;
      }
    }
    if (epoch !== this.epoch || this.stopped) return;
    if (!cred) {
      this.update({
        phase: "failed",
        hello: null,
        authMethod: null,
        failure: {
          kind: "auth",
          code: null,
          needsCode: true,
          message: "Pair this browser with the edge daemon to connect.",
          hint: "Sign in so the app can pair automatically, or run `edge-daemon pair` and type the 6-digit code.",
        },
      });
      return;
    }
    this.method = cred.method;
    const credential = cred;
    this.transport = this.opts.transport({
      onOpen: () => {
        if (epoch !== this.epoch) return;
        this.sendHello(credential);
      },
      onMessage: (text) => {
        if (epoch !== this.epoch) return;
        this.handle(text);
      },
      onClose: (wasOpen, blocked, detail) => {
        if (epoch !== this.epoch) return;
        this.onClosed(wasOpen, blocked ?? false, detail);
      },
    });
  }

  private sendHello(cred: Credential): void {
    this.helloId = newId();
    if (cred.method === "code") this.pendingCode = null; // single use, consumed now
    this.update({ phase: "handshaking" });
    this.transport?.send(
      toWire({
        type: "HelloRequest",
        request_id: this.helloId,
        client_token: cred.token,
        client_version: this.opts.clientVersion,
        protocol_version: PROTOCOL_VERSION,
        policy_version: POLICY_VERSION,
      }),
    );
    this.helloTimer = setTimeout(() => {
      this.fail(
        {
          kind: "protocol",
          code: "TIMEOUT",
          needsCode: false,
          message: "The daemon accepted the connection but never answered the handshake.",
          hint: "Restart the edge daemon, then retry.",
        },
        true,
      );
    }, this.opts.helloTimeoutMs ?? 8000);
  }

  private fail(failure: EdgeFailure, retry: boolean): void {
    this.clearTimers();
    this.epoch += 1;
    this.transport?.close();
    this.transport = null;
    this.rejectAll(failure.message);
    if (retry) this.scheduleRetry(failure);
    else this.update({ phase: "failed", failure, hello: null, retryInMs: null });
  }

  private notRunning(): void {
    this.scheduleRetry({
      kind: "unreachable",
      code: null,
      needsCode: false,
      message: "The edge daemon is not running on this computer (ws://127.0.0.1:8765).",
      hint: "Start it with `edge-daemon` (or `cargo run -p edge-daemon`); the app reconnects by itself.",
    });
  }

  private onClosed(wasOpen: boolean, blocked: boolean, detail?: TransportCloseDetail): void {
    const was = this.snap.phase;
    this.clearTimers();
    this.transport = null;
    this.rejectAll("The connection to the daemon dropped.");
    if (this.stopped) return;
    if (detail) {
      // The transport knows the cause (the app's link to the PC).
      if (detail.retry) this.scheduleRetry(detail.failure);
      else this.update({ phase: "failed", failure: detail.failure, hello: null, retryInMs: null });
      return;
    }
    if (!wasOpen && this.snap.mode === "daemon") {
      // A SecurityError (mixed content, CSP) won't clear without a page change: stop and say how to fix it.
      if (blocked) {
        this.update({ phase: "failed", failure: BLOCKED_FAILURE, hello: null, retryInMs: null });
        return;
      }
      // A denied permission can be granted while the page is open, so keep retrying.
      const probe = this.opts.localAccessBlocked;
      if (probe) {
        const epoch = this.epoch;
        void probeWithin(probe, LOCAL_ACCESS_PROBE_MS).then((denied) => {
          if (epoch !== this.epoch || this.stopped) return;
          if (denied) this.scheduleRetry(BLOCKED_FAILURE);
          else this.notRunning();
        });
        return;
      }
      this.notRunning();
      return;
    }
    if (!wasOpen) {
      this.scheduleRetry({
        kind: "unreachable",
        code: null,
        needsCode: false,
        message: "The browser demo stopped.",
        hint: "Switch to the browser demo again, or connect the real daemon.",
      });
      return;
    }
    if (was === "ready" && this.method === "code") {
      // Codes are single-use: a dropped code session needs a new one unless
      // the cloud can pair us.
      void this.opts.credential().then((cred) => {
        if (this.stopped) return;
        if (cred) this.scheduleRetry(null);
        else
          this.update({
            phase: "failed",
            hello: null,
            failure: {
              kind: "auth",
              code: null,
              needsCode: true,
              message: "The daemon connection dropped. Pairing codes work once, so pair again.",
              hint: "Run `edge-daemon pair` and type the new 6-digit code.",
            },
          });
      });
      return;
    }
    if (was === "handshaking") {
      // Closed during the handshake without an ErrorResponse (e.g. origin).
      this.scheduleRetry({
        kind: "origin",
        code: null,
        needsCode: false,
        message: "The daemon closed the connection during the handshake.",
        hint: errorHint("ORIGIN_REJECTED"),
      });
      return;
    }
    if (was === "failed") return;
    this.scheduleRetry(null);
  }

  private handle(text: string): void {
    const parsed = parseMessage(text);
    if (!parsed.ok) {
      console.warn("edge daemon sent a message the app can't read:", parsed.error);
      return;
    }
    const m = parsed.message;
    if (this.snap.phase === "handshaking") {
      if (m.type === "HelloResponse" && m.request_id === this.helloId) {
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.attempt = 0;
        const note =
          m.protocol_version === PROTOCOL_VERSION
            ? null
            : versionsCompatible(PROTOCOL_VERSION, m.protocol_version)
              ? `The daemon speaks protocol ${m.protocol_version}; this app speaks ${PROTOCOL_VERSION}. They're compatible, but updating both keeps every feature available.`
              : null;
        this.update({
          phase: "ready",
          hello: m,
          failure: null,
          retryInMs: null,
          versionNote: note,
          authMethod: this.method,
          generation: this.snap.generation + 1,
        });
        return;
      }
      if (m.type === "ErrorResponse") {
        const f = failureFor(m.code, m.message, m.hint || errorHint(m.code), this.method, this.opts.phone);
        // Auth and version problems won't fix themselves: stop and ask.
        this.fail(f, f.kind === "protocol");
        return;
      }
      return;
    }
    const rid = "request_id" in m ? (m.request_id as string | null) : null;
    if (rid && this.pending.has(rid)) {
      const p = this.pending.get(rid)!;
      this.pending.delete(rid);
      clearTimeout(p.timer);
      if (m.type === "ErrorResponse") {
        p.reject(
          new EdgeRequestError(m.code, m.message, m.hint || errorHint(m.code), m.detail_json ?? null),
        );
      } else if (m.type === p.expect) {
        p.resolve(m);
      } else {
        p.reject(
          new EdgeRequestError(
            "BAD_RESPONSE",
            `Expected ${p.expect}, got ${m.type}.`,
            "Update the edge daemon and the app to matching versions.",
          ),
        );
      }
    }
    const set = this.listeners.get(m.type as PushType);
    if (set) for (const fn of set) fn(m);
  }
}
