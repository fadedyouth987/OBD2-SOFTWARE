"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type EdgeLeaseGrant } from "@/lib/api";
import { browserSimTransport } from "@/lib/browser-sim";
import { APP_VERSION, EDGE_WS_URL } from "@/lib/config";
import {
  EdgeClient,
  EdgeRequestError,
  INITIAL_SNAPSHOT,
  webSocketTransport,
  type Credential,
  type EdgeMode,
  type EdgeSnapshot,
  browserBlocksLocalAccess,
} from "@/lib/edge-client";
import { useAuth } from "@/context/auth";
import type {
  AdapterInfo,
  BusProtocol,
  DiagCommandResponse,
  DiagProtocol,
  HeuristicAlert,
  LeaseKind,
  LeaseStatus,
  PidSample,
  SafetyConfirmResponse,
  SafetyMode,
} from "@/types/edge-protocol";

const MODE_KEY = "rootcause.edgeMode";
/**
 * The adapter this tab last connected (sessionStorage: per tab, survives a
 * reload). A new daemon session (reload, daemon restart) reconnects it, always
 * read-only (SILENT): Active mode is only ever a deliberate choice.
 */
export const LINK_KEY = "rootcause.adapterLink";

interface SavedLink {
  adapterId: string;
  protocol: BusProtocol;
}

function savedLink(): SavedLink | null {
  try {
    const raw = window.sessionStorage.getItem(LINK_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<SavedLink>) : null;
    return v && typeof v.adapterId === "string" && typeof v.protocol === "string" ? (v as SavedLink) : null;
  } catch {
    return null;
  }
}

function saveLink(v: SavedLink | null): void {
  try {
    if (v) window.sessionStorage.setItem(LINK_KEY, JSON.stringify(v));
    else window.sessionStorage.removeItem(LINK_KEY);
  } catch {
    // Storage blocked: the tab just won't reconnect by itself.
  }
}
/** Live data kept in memory for charts: two minutes per PID. */
export const PID_WINDOW_MS = 120_000;

export interface LinkState {
  adapter: AdapterInfo | null;
  adapterId: string;
  state: "CONNECTED" | "DISCONNECTED" | "ERROR" | "CONNECTING";
  batteryV: number | null;
  safetyMode: SafetyMode;
  protocol: BusProtocol;
  since: number;
}

export interface PidPoint {
  t: number;
  v: number;
}

export interface PidSeries {
  pid: number;
  name: string;
  unit: string;
  points: PidPoint[];
}

export interface DiagRequest {
  tx: number;
  rx: number;
  protocol: DiagProtocol;
  payloadHex: string;
  safetyToken?: string | null;
  timeoutMs?: number;
}

export interface LeaseSyncState {
  status: "idle" | "syncing" | "ok" | "error";
  message: string | null;
  at: number | null;
}

interface EdgeValue {
  snapshot: EdgeSnapshot;
  mode: EdgeMode;
  setMode: (m: EdgeMode) => void;
  retry: () => void;
  pairWithCode: (code: string) => void;
  client: EdgeClient | null;
  adapters: AdapterInfo[] | null;
  adaptersError: string | null;
  refreshAdapters: () => Promise<AdapterInfo[] | null>;
  link: LinkState | null;
  linkError: EdgeRequestError | null;
  connectAdapter: (adapterId: string, opts?: { protocol?: BusProtocol; safetyMode?: SafetyMode }) => Promise<void>;
  disconnectAdapter: () => Promise<void>;
  lease: LeaseStatus | null;
  refreshLease: () => Promise<LeaseStatus | null>;
  installLease: (kind: LeaseKind, token: string) => Promise<LeaseStatus>;
  /** Fetches a fresh diagnostic lease from the cloud and installs it on the daemon. */
  syncLease: () => Promise<void>;
  leaseSync: LeaseSyncState;
  alerts: HeuristicAlert[];
  /** Latest value per PID. */
  pids: Map<number, PidSample>;
  /** Rolling history; read inside render after `pidTick` changes. */
  pidHistory: React.RefObject<Map<number, PidSeries>>;
  pidTick: number;
  /** When this browser last received each PID (Date.now() ms), for freshness checks. */
  pidSeenAt: Map<number, number>;
  /** When this browser last received any live sample, or null if none since connecting. */
  lastSampleAt: number | null;
  diag: (req: DiagRequest) => Promise<DiagCommandResponse>;
  requestSafetyToken: (req: DiagRequest & { ack: string; serviceId?: number }) => Promise<SafetyConfirmResponse>;
  ready: boolean;
}

const EdgeContext = createContext<EdgeValue | null>(null);

function readMode(): EdgeMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "browser-sim" ? "browser-sim" : "daemon";
  } catch {
    return "daemon";
  }
}

export function EdgeProvider({ children }: { children: React.ReactNode }) {
  const { token, status, me } = useAuth();
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const [mode, setModeState] = useState<EdgeMode | null>(null);
  const [snapshot, setSnapshot] = useState<EdgeSnapshot>(INITIAL_SNAPSHOT);
  const [client, setClient] = useState<EdgeClient | null>(null);
  const [adapters, setAdapters] = useState<AdapterInfo[] | null>(null);
  const [adaptersError, setAdaptersError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkState | null>(null);
  const [linkError, setLinkError] = useState<EdgeRequestError | null>(null);
  const [lease, setLease] = useState<LeaseStatus | null>(null);
  const [leaseSync, setLeaseSync] = useState<LeaseSyncState>({ status: "idle", message: null, at: null });
  const autoSyncedRef = useRef<number>(-1);
  const [alerts, setAlerts] = useState<HeuristicAlert[]>([]);
  const [pids, setPids] = useState<Map<number, PidSample>>(new Map());
  const [pidTick, setPidTick] = useState(0);
  const [pidSeenAt, setPidSeenAt] = useState<Map<number, number>>(new Map());
  const [lastSampleAt, setLastSampleAt] = useState<number | null>(null);
  const seenRef = useRef<Map<number, number>>(new Map());
  const pidHistory = useRef<Map<number, PidSeries>>(new Map());
  const latestRef = useRef<Map<number, PidSample>>(new Map());
  const dirtyRef = useRef(false);
  const adaptersRef = useRef<AdapterInfo[] | null>(null);
  adaptersRef.current = adapters;

  useEffect(() => setModeState(readMode()), []);

  // One client per mode; it lives as long as the app shell.
  useEffect(() => {
    if (mode === null || status === "loading") return;
    const credential = async (): Promise<Credential | null> => {
      if (mode === "browser-sim") return { token: "browser-demo", method: "sim" };
      const t = tokenRef.current;
      if (!t) return null;
      try {
        const grant = await api<{ token: string }>("/api/v1/auth/edge-pairing", {
          body: { origin: window.location.origin },
          token: t,
        });
        return { token: grant.token, method: "cloud" };
      } catch {
        return null;
      }
    };
    const c = new EdgeClient({
      mode,
      transport: mode === "browser-sim" ? browserSimTransport() : webSocketTransport(EDGE_WS_URL),
      clientVersion: APP_VERSION,
      credential,
      onSnapshot: setSnapshot,
      localAccessBlocked: browserBlocksLocalAccess,
    });
    setClient(c);
    c.start();
    return () => {
      c.stop();
      setClient(null);
    };
    // Re-pair when the user signs in or out (status), not on every token refresh.
  }, [mode, status]);

  const ready = snapshot.phase === "ready";

  // Push subscriptions.
  useEffect(() => {
    if (!client) return;
    const offs = [
      client.on("ObdPidStream", (m) => {
        if (m.type !== "ObdPidStream") return;
        const now = Date.now();
        for (const s of m.samples) {
          latestRef.current.set(s.pid, s);
          seenRef.current.set(s.pid, now);
          let series = pidHistory.current.get(s.pid);
          if (!series) {
            series = { pid: s.pid, name: s.name, unit: s.unit, points: [] };
            pidHistory.current.set(s.pid, series);
          }
          series.points.push({ t: s.timestamp_us / 1000, v: s.value });
          const cutoff = now - PID_WINDOW_MS;
          let drop = 0;
          while (drop < series.points.length && series.points[drop].t < cutoff) drop += 1;
          if (drop > 0) series.points.splice(0, drop);
        }
        dirtyRef.current = true;
      }),
      client.on("HeuristicAlert", (m) => {
        if (m.type !== "HeuristicAlert") return;
        setAlerts((prev) => [...prev.filter((a) => a.rule_id !== m.rule_id), m]);
      }),
      client.on("AdapterStatus", (m) => {
        if (m.type !== "AdapterStatus") return;
        setLink((prev) => {
          if (!prev || prev.adapterId !== m.adapter_id) return prev;
          if (m.state === "DISCONNECTED") {
            saveLink(null); // unplugged: don't reconnect it on the next load
            return null;
          }
          return { ...prev, state: m.state, batteryV: m.battery_v ?? prev.batteryV };
        });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [client]);

  // Re-render live data at 4 Hz at most.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setPids(new Map(latestRef.current));
      setPidSeenAt(new Map(seenRef.current));
      setLastSampleAt(Math.max(...seenRef.current.values()));
      setPidTick((n) => n + 1);
    }, 250);
    return () => clearInterval(timer);
  }, []);

  const resetVehicleState = useCallback(() => {
    setLink(null);
    setAlerts([]);
    latestRef.current = new Map();
    seenRef.current = new Map();
    pidHistory.current = new Map();
    setPids(new Map());
    setPidSeenAt(new Map());
    setLastSampleAt(null);
  }, []);

  const refreshAdapters = useCallback(async (): Promise<AdapterInfo[] | null> => {
    if (!client) return null;
    try {
      const res = await client.request({ type: "AdapterListRequest" });
      adaptersRef.current = res.adapters;
      setAdapters(res.adapters);
      setAdaptersError(null);
      return res.adapters;
    } catch (e) {
      setAdaptersError(e instanceof EdgeRequestError ? `${e.message} ${e.hint}` : String(e));
      return null;
    }
  }, [client]);

  const refreshLease = useCallback(async () => {
    if (!client) return null;
    try {
      const res = await client.request({ type: "LeaseStatusRequest" });
      setLease(res);
      return res;
    } catch {
      return null;
    }
  }, [client]);

  // Each new daemon session: nothing is connected yet; fetch lease + adapters.
  useEffect(() => {
    if (!ready) {
      resetVehicleState();
      if (snapshot.phase !== "waiting") setLease(null);
      return;
    }
    void refreshAdapters().then((list) => {
      // Reconnect the adapter this tab had before a reload or a daemon restart.
      const saved = savedLink();
      if (!saved || !list?.some((a) => a.adapter_id === saved.adapterId)) return;
      connectAdapter(saved.adapterId, { protocol: saved.protocol, safetyMode: "SILENT" }).catch(() => saveLink(null));
    });
    void refreshLease();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, snapshot.generation]);

  const connectAdapter = useCallback(
    async (adapterId: string, opts?: { protocol?: BusProtocol; safetyMode?: SafetyMode }) => {
      if (!client) throw new EdgeRequestError("NOT_CONNECTED", "The daemon isn't connected.", "Open Devices.");
      const protocol = opts?.protocol ?? "AUTO";
      const safetyMode = opts?.safetyMode ?? "SILENT";
      const adapter = adaptersRef.current?.find((a) => a.adapter_id === adapterId) ?? null;
      setLinkError(null);
      setAlerts([]);
      latestRef.current = new Map();
      pidHistory.current = new Map();
      setLink({ adapter, adapterId, state: "CONNECTING", batteryV: null, safetyMode, protocol, since: Date.now() });
      try {
        const res = await client.request(
          { type: "ConnectRequest", adapter_id: adapterId, protocol, baud_rate: null, safety_mode: safetyMode },
          20_000,
        );
        if (res.state !== "CONNECTED") {
          setLink(null);
          throw new EdgeRequestError(
            "ADAPTER_ERROR",
            `The adapter reported ${res.state.toLowerCase()}.`,
            "Check the cable and ignition, then try again.",
          );
        }
        setLink({ adapter, adapterId, state: "CONNECTED", batteryV: res.battery_v, safetyMode, protocol, since: Date.now() });
        saveLink({ adapterId, protocol });
      } catch (e) {
        setLink(null);
        const err =
          e instanceof EdgeRequestError ? e : new EdgeRequestError("ADAPTER_ERROR", String(e), "Try again.");
        setLinkError(err);
        throw err;
      }
    },
    [client],
  );

  const disconnectAdapter = useCallback(async () => {
    if (!client || !link) return;
    try {
      await client.request({ type: "DisconnectRequest", adapter_id: link.adapterId });
    } finally {
      saveLink(null);
      resetVehicleState();
    }
  }, [client, link, resetVehicleState]);

  const installLease = useCallback(
    async (kind: LeaseKind, leaseToken: string) => {
      if (!client) throw new EdgeRequestError("NOT_CONNECTED", "The daemon isn't connected.", "Open Devices.");
      const res = await client.request({ type: "LeaseInstallRequest", kind, lease_token: leaseToken });
      setLease(res);
      return res;
    },
    [client],
  );

  const syncLease = useCallback(async () => {
    const t = tokenRef.current;
    if (!client || !t) return;
    setLeaseSync({ status: "syncing", message: null, at: null });
    try {
      const grant = await api<EdgeLeaseGrant>("/api/v1/auth/edge-lease", { body: {}, token: t });
      const res = await client.request({ type: "LeaseInstallRequest", kind: "DIAGNOSTIC", lease_token: grant.token });
      setLease(res);
      setLeaseSync({ status: "ok", message: null, at: Date.now() });
    } catch (e) {
      const message =
        e instanceof EdgeRequestError
          ? `${e.message} ${e.hint}`
          : e instanceof ApiError
            ? e.message
            : "Couldn't refresh the lease.";
      setLeaseSync({ status: "error", message, at: Date.now() });
    }
  }, [client]);

  // Deliver the workshop's lease automatically: once per daemon session, when
  // the daemon can verify cloud leases and its lease doesn't match the plan or
  // ends within six hours.
  useEffect(() => {
    if (!ready || !lease || !me || mode !== "daemon") return;
    if (autoSyncedRef.current === snapshot.generation) return;
    if (!lease.cloud_keys_pinned) return;
    const planTier = me.entitlements.tier;
    const ends = lease.expires_at ? new Date(lease.expires_at).getTime() : null;
    const stale = lease.lease_tier !== planTier || (ends !== null && ends - Date.now() < 6 * 3600_000);
    const wantsImmo = me.entitlements.immo_entitled && !lease.features.includes("IMMO_PROGRAM");
    if (!stale && !wantsImmo) return;
    if (planTier === "COMMUNITY" && lease.lease_tier === "COMMUNITY") return;
    autoSyncedRef.current = snapshot.generation;
    void syncLease();
  }, [ready, lease, me, mode, snapshot.generation, syncLease]);

  const diag = useCallback(
    async (req: DiagRequest) => {
      if (!client) throw new EdgeRequestError("NOT_CONNECTED", "The daemon isn't connected.", "Open Devices.");
      const sid = Number.parseInt(req.payloadHex.slice(0, 2), 16);
      return client.request(
        {
          type: "DiagCommandRequest",
          tx_id: req.tx,
          rx_id: req.rx,
          protocol: req.protocol,
          service_id: sid,
          payload_hex: req.payloadHex,
          safety_token: req.safetyToken ?? null,
        },
        req.timeoutMs ?? 10_000,
      );
    },
    [client],
  );

  const requestSafetyToken = useCallback(
    async (req: DiagRequest & { ack: string }) => {
      if (!client) throw new EdgeRequestError("NOT_CONNECTED", "The daemon isn't connected.", "Open Devices.");
      return client.request({
        type: "SafetyConfirmRequest",
        tx_id: req.tx,
        rx_id: req.rx,
        protocol: req.protocol,
        service_id: Number.parseInt(req.payloadHex.slice(0, 2), 16),
        payload_hex: req.payloadHex,
        user_ack_text: req.ack.slice(0, 512),
      });
    },
    [client],
  );

  const setMode = useCallback((m: EdgeMode) => {
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
    setAdapters(null);
    setLease(null);
    setModeState(m);
  }, []);

  const value = useMemo<EdgeValue>(
    () => ({
      snapshot,
      mode: mode ?? "daemon",
      setMode,
      retry: () => client?.retry(),
      pairWithCode: (code: string) => client?.pairWithCode(code),
      client,
      adapters,
      adaptersError,
      refreshAdapters,
      link,
      linkError,
      connectAdapter,
      disconnectAdapter,
      lease,
      refreshLease,
      installLease,
      syncLease,
      leaseSync,
      alerts,
      pids,
      pidHistory,
      pidTick,
      pidSeenAt,
      lastSampleAt,
      diag,
      requestSafetyToken,
      ready,
    }),
    [snapshot, mode, setMode, client, adapters, adaptersError, refreshAdapters, link, linkError, connectAdapter, disconnectAdapter, lease, refreshLease, installLease, syncLease, leaseSync, alerts, pids, pidTick, pidSeenAt, lastSampleAt, diag, requestSafetyToken, ready],
  );
  return <EdgeContext.Provider value={value}>{children}</EdgeContext.Provider>;
}

export function useEdge(): EdgeValue {
  const v = useContext(EdgeContext);
  if (!v) throw new Error("useEdge outside EdgeProvider");
  return v;
}
