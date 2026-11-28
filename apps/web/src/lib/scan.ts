// Whole-vehicle DTC scan: OBD modes 03/07/0A on the engine ECU, then UDS
// 0x19 / KWP2000 0x18 on every known module. Each module reports what really
// happened: codes, "no codes", a refusal (NRC) or no response.

import { parseObdDtcs, parseUdsDtcs, bytesOf, dtcText, nrcText, parseRegistryId, type ReadDtc } from "@/lib/diag";
import { EdgeRequestError } from "@/lib/edge-client";
import type { DiagCommandResponse, DiagProtocol } from "@/types/edge-protocol";
import type { VehicleModule } from "@/lib/api";

export type ScanProtocol = "UDS" | "KWP2000";

export interface ScanTarget {
  module: string;
  tx: number;
  rx: number;
  /** Enhanced protocol for this module, or null for OBD only. */
  protocol: ScanProtocol | null;
  /** Also run OBD modes 03/07/0A here (the engine ECU). */
  obd: boolean;
  /** Full module name, when the registry or the module catalogue has one. */
  name?: string | null;
  /** Found by an address sweep rather than listed for this vehicle. */
  discovered?: boolean;
}

export interface ScanDtc extends ReadDtc {
  module: string;
  source: string;
}

/** "other_network": listed for this vehicle but on a network this connection can't reach. */
export type ModuleOutcome = "codes" | "clear" | "refused" | "no_response" | "error" | "other_network";

export interface ModuleResult {
  target: ScanTarget;
  outcome: ModuleOutcome;
  dtcs: ScanDtc[];
  message: string;
}

export type DiagFn = (req: {
  tx: number;
  rx: number;
  protocol: DiagProtocol;
  payloadHex: string;
}) => Promise<DiagCommandResponse>;

const ENGINE: ScanTarget = { module: "ENGINE", tx: 0x7e0, rx: 0x7e8, protocol: "UDS", obd: true };

/** The modules each built-in virtual vehicle really simulates. */
export const VIRTUAL_TARGETS: Record<string, ScanTarget[]> = {
  "ford-falcon-ba": [
    { module: "PCM", tx: 0x7e0, rx: 0x7e8, protocol: "UDS", obd: true },
    { module: "IC", tx: 0x720, rx: 0x728, protocol: "UDS", obd: false },
    { module: "ABS", tx: 0x760, rx: 0x768, protocol: "UDS", obd: false },
  ],
  "generic-uds": [ENGINE],
  "sandbox-immo": [ENGINE, { module: "IMMO", tx: 0x7e2, rx: 0x7ea, protocol: "UDS", obd: false }],
  "bmw-e90-dcan": [
    { module: "DME", tx: 0x6f1, rx: 0x612, protocol: "KWP2000", obd: false },
    { module: "DME (OBD)", tx: 0x7e0, rx: 0x7e8, protocol: null, obd: true },
    { module: "CAS", tx: 0x6f1, rx: 0x640, protocol: "KWP2000", obd: false },
    { module: "DSC", tx: 0x6f1, rx: 0x629, protocol: "KWP2000", obd: false },
  ],
};

/** Profiles whose bus the app can't reach through the daemon's diag channel. */
export const UNSCANNABLE_VIRTUAL = new Set(["bmw-e90-pre2007"]);

/**
 * Targets for a vehicle: the simulator's own map for virtual adapters, else
 * the registry modules for the decoded profile, else plain OBD on the engine.
 */
export function scanTargets(adapterId: string | null, modules: VehicleModule[] | null): ScanTarget[] {
  if (adapterId?.startsWith("virtual-")) {
    const sim = VIRTUAL_TARGETS[adapterId.slice("virtual-".length)];
    if (sim) return sim;
  }
  const out: ScanTarget[] = [];
  let engineCovered = false;
  for (const m of modules ?? []) {
    const tx = parseRegistryId(m.tx);
    const rx = parseRegistryId(m.rx);
    // 0x7DF is the functional (broadcast) OBD address, covered by ENGINE below.
    if (tx === null || rx === null || tx === 0x7df) continue;
    const bmw = tx === 0x6f1;
    const engine = tx === 0x7e0;
    engineCovered ||= engine;
    out.push({ module: m.id, tx, rx, protocol: bmw ? "KWP2000" : "UDS", obd: engine });
  }
  if (!engineCovered) out.unshift({ module: "ENGINE", tx: 0x7e0, rx: 0x7e8, protocol: null, obd: true });
  return out;
}

/** KWP2000 58 NN [hi lo status]... BMW codes are shown in their own hex form. */
export function parseKwpDtcs(responseHex: string): ReadDtc[] {
  const b = bytesOf(responseHex);
  if (b[0] !== 0x58) return [];
  const out: ReadDtc[] = [];
  for (let i = 2; i + 2 < b.length; i += 3) {
    const [hi, lo, st] = [b[i], b[i + 1], b[i + 2]];
    if (hi === 0 && lo === 0) continue;
    const code = ((hi << 8) | lo).toString(16).toUpperCase().padStart(4, "0");
    out.push({ code, status: st & 0x20 || st & 0x08 ? "stored" : "history", statusByte: st, ftb: null });
  }
  return out;
}

async function ask(diag: DiagFn, t: ScanTarget, protocol: DiagProtocol, payloadHex: string) {
  try {
    const res = await diag({ tx: t.tx, rx: t.rx, protocol, payloadHex });
    return { res, err: null as EdgeRequestError | Error | null };
  } catch (e) {
    return { res: null, err: e as Error };
  }
}

export async function scanModule(diag: DiagFn, t: ScanTarget): Promise<ModuleResult> {
  const dtcs: ScanDtc[] = [];
  const notes: string[] = [];
  let answered = false;
  let refused = false;
  let failure: string | null = null;

  const record = (list: ReadDtc[], source: string) => {
    for (const d of list) dtcs.push({ ...d, module: t.module, source });
  };

  const steps: [DiagProtocol, string, string][] = [];
  if (t.obd) {
    steps.push(["OBD", "03", "OBD mode 03"], ["OBD", "07", "OBD mode 07"], ["OBD", "0A", "OBD mode 0A"]);
  }
  if (t.protocol === "UDS") steps.push(["UDS", "1902FF", "UDS 19 02"]);
  if (t.protocol === "KWP2000") steps.push(["KWP2000", "1802FF00", "KWP 18"]);

  for (const [protocol, payload, source] of steps) {
    const { res, err } = await ask(diag, t, protocol, payload);
    if (err) {
      if (err instanceof EdgeRequestError && (err.code === "TIMEOUT" || err.code === "CLIENT_TIMEOUT")) {
        notes.push(`${source}: no response`);
        // A module that ignores one service may still answer another; but if
        // the first request times out the module is almost certainly absent.
        if (!answered && steps[0][2] === source) {
          return { target: t, outcome: "no_response", dtcs: [], message: "The module didn't respond." };
        }
        continue;
      }
      failure = err instanceof EdgeRequestError ? `${err.message} ${err.hint}` : err.message;
      break;
    }
    answered = true;
    if (!res!.positive) {
      // A module that answers but doesn't know UDS 19 (serviceNotSupported) is
      // usually a KWP2000 module (many Nissan, older Toyota): ask it that way.
      if (protocol === "UDS" && res!.nrc?.code === 0x11 && !steps.some((s) => s[0] === "KWP2000")) {
        steps.push(["KWP2000", "1802FF00", "KWP 18"]);
        notes.push(`${source}: not supported, asked with KWP2000 instead.`);
        continue;
      }
      refused = true;
      notes.push(`${source}: ${nrcText(res!.nrc?.code ?? 0x10, res!.nrc?.name)}`);
      continue;
    }
    const hex = res!.response_hex;
    if (payload === "03") record(parseObdDtcs(0x03, hex), source);
    else if (payload === "07") record(parseObdDtcs(0x07, hex), source);
    else if (payload === "0A") record(parseObdDtcs(0x0a, hex), source);
    else if (protocol === "UDS") record(parseUdsDtcs(hex), source);
    else record(parseKwpDtcs(hex), source);
  }

  if (failure && !answered) return { target: t, outcome: "error", dtcs, message: failure };
  const merged = mergeDtcs(dtcs);
  if (merged.length > 0) {
    return { target: t, outcome: "codes", dtcs: merged, message: `${merged.length} code${merged.length === 1 ? "" : "s"}` };
  }
  if (refused && !dtcs.length && notes.length === steps.length) {
    return { target: t, outcome: "refused", dtcs: [], message: notes.join(" ") };
  }
  return { target: t, outcome: "clear", dtcs: [], message: failure ?? "No codes stored." };
}

const STATUS_RANK: Record<string, number> = { confirmed: 0, stored: 1, permanent: 2, pending: 3, history: 4 };

/** One row per code and module; keeps the most serious status and all sources. */
export function mergeDtcs(list: ScanDtc[]): ScanDtc[] {
  const by = new Map<string, ScanDtc>();
  for (const d of list) {
    const key = `${d.module}|${d.code}`;
    const prev = by.get(key);
    if (!prev) {
      by.set(key, { ...d });
      continue;
    }
    const better = (STATUS_RANK[d.status] ?? 9) < (STATUS_RANK[prev.status] ?? 9) ? d : prev;
    const sources = new Set([...prev.source.split(", "), d.source]);
    by.set(key, {
      ...better,
      statusByte: prev.statusByte ?? d.statusByte,
      ftb: prev.ftb ?? d.ftb,
      source: [...sources].join(", "),
    });
  }
  return [...by.values()];
}

export { dtcText };

/** The shape the job stores (matches JobDtc in lib/api). */
export interface RecordedDtc {
  code: string;
  module: string;
  status: string;
  source: string;
  description: string;
  status_byte: number | null;
}

/**
 * Combine a fresh scan with the codes already recorded on the job, so a
 * rescan (for example verifying a clear) never erases what was found:
 * - codes read now replace the recorded entry for the same code and module;
 * - a recorded code whose module answered this scan without it is kept as
 *   "cleared" (it was there earlier this visit, it's gone now);
 * - codes from modules that didn't answer this time are left as they were.
 */
export function mergeJobDtcs(previous: RecordedDtc[], results: ModuleResult[], fresh: RecordedDtc[]): RecordedDtc[] {
  const answered = new Set(
    results.filter((r) => r.outcome === "codes" || r.outcome === "clear").map((r) => r.target.module),
  );
  const key = (d: { code: string; module: string }) => `${d.module}|${d.code}`;
  const now = new Set(fresh.map(key));
  const kept = previous
    .filter((d) => !now.has(key(d)))
    .map((d) => (answered.has(d.module) && d.status !== "cleared" ? { ...d, status: "cleared" } : d));
  return [...fresh, ...kept];
}
