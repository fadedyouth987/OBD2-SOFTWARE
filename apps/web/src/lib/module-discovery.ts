// Module discovery: find every module that answers on the connected network,
// FORScan-style, instead of trusting a hand-written list.
//
// 1. Plan: the vehicle's registry modules and its make family's catalogue
//    modules first (so named modules fill in early), then the family's address
//    sweeps. Registry modules on another network (MS-CAN, J1850...) aren't
//    probed; they're reported as needing that network, never as "didn't respond".
// 2. Probe each address with TesterPresent (read-only, not gated). Any reply,
//    positive or negative, means a module is there.
// 3. The caller reads codes from what answered (scan.ts scanModule).

import { EdgeRequestError } from "@/lib/edge-client";
import type { VehicleModule } from "@/lib/api";
import type { ModuleResult, ScanTarget } from "@/lib/scan";
import type { BusProtocol, DiagProtocol } from "@/types/edge-protocol";
import {
  BMW_TESTER,
  CATALOG,
  catalogName,
  familyFor,
  hex,
  is29Bit,
  parseHex,
  sweepAddresses,
  unnamedLabel,
} from "@/lib/module-catalog";

export type Network = "HS_CAN" | "HS_CAN2" | "MS_CAN" | "SW_CAN" | "J1850_PWM" | "J1850_VPW" | "KLINE" | "ALDL";

export const NETWORK_LABEL: Record<Network, string> = {
  HS_CAN: "HS-CAN (OBD pins 6/14)",
  HS_CAN2: "second HS-CAN (OBD pins 3/11 on most Fords)",
  MS_CAN: "MS-CAN 125k (OBD pins 3/11)",
  SW_CAN: "GM single-wire CAN (OBD pin 1)",
  J1850_PWM: "J1850 PWM",
  J1850_VPW: "J1850 VPW",
  KLINE: "K-line",
  ALDL: "GM ALDL (8192 baud)",
};

/** What it takes to reach a network RootCause isn't connected to. */
const NETWORK_HOW: Record<Network, string> = {
  HS_CAN: "Reconnect the adapter on HS-CAN.",
  HS_CAN2: "RootCause can't switch to this network yet.",
  MS_CAN: "Reconnect on MS-CAN 125k with an STN-based adapter (e.g. OBDLink); plain ELM327 adapters can't reach it.",
  SW_CAN: "RootCause can't reach single-wire CAN yet.",
  J1850_PWM: "Reconnect the adapter on J1850 PWM.",
  J1850_VPW: "Reconnect the adapter on J1850 VPW.",
  KLINE: "Reconnect the adapter on K-line.",
  ALDL: "RootCause can't read ALDL yet.",
};

const CAN_NETWORKS = new Set<Network>(["HS_CAN", "HS_CAN2", "MS_CAN"]);

/** The network a connection is on, from the bus protocol it was opened with. */
export function networkOf(protocol: BusProtocol | null | undefined): Network {
  switch (protocol) {
    case "MS_CAN_125":
      return "MS_CAN";
    case "J1850_PWM":
      return "J1850_PWM";
    case "J1850_VPW":
      return "J1850_VPW";
    case "ISO14230_FAST":
    case "ISO14230_5BAUD":
    case "ISO9141_2":
      return "KLINE";
    default:
      return "HS_CAN";
  }
}

/** A registry module's network: the explicit field, else inferred from its bus text. */
export function moduleNetwork(m: Pick<VehicleModule, "bus"> & { network?: string | null }): Network {
  if (m.network && m.network in NETWORK_LABEL) return m.network as Network;
  const b = m.bus.toUpperCase();
  if (b.includes("MS-CAN") || b.includes("MSCAN")) return "MS_CAN";
  if (b.includes("SW-CAN") || b.includes("33.3")) return "SW_CAN";
  if (b.includes("PWM")) return "J1850_PWM";
  if (b.includes("VPW")) return "J1850_VPW";
  if (b.includes("ALDL")) return "ALDL";
  if (b.includes("K-LINE") || b.includes("KLINE")) return "KLINE";
  return "HS_CAN";
}

export interface Probe {
  tx: number;
  rx: number;
  protocol: "UDS" | "KWP2000";
  /** Shown to the technician: registry id, catalogue abbreviation, or the address. */
  label: string;
  /** Full name when one is known. */
  name: string | null;
  /** Listed in the registry or the catalogue (as opposed to found by a sweep). */
  named: boolean;
  sweep: string | null;
}

export interface DiscoveryPlan {
  family: string;
  network: Network;
  probes: Probe[];
  /** Registry modules on a network this connection can't reach. */
  elsewhere: ModuleResult[];
  notes: string[];
}

function key(tx: number, rx: number) {
  return `${tx}:${rx}`;
}

export function buildPlan(opts: {
  family: string | null | undefined;
  registryModules: (VehicleModule & { network?: string | null })[] | null;
  protocol: BusProtocol | null | undefined;
}): DiscoveryPlan {
  const { id, family } = familyFor(opts.family);
  const network = networkOf(opts.protocol);
  const probes: Probe[] = [];
  const seen = new Set<string>();
  const elsewhere: ModuleResult[] = [];
  const notes: string[] = [];

  const add = (p: Probe) => {
    const k = key(p.tx, p.rx);
    if (seen.has(k) || p.tx === 0x7df) return;
    seen.add(k);
    probes.push(p);
  };

  for (const m of opts.registryModules ?? []) {
    const tx = parseHex(m.tx);
    const rx = parseHex(m.rx);
    const net = moduleNetwork(m);
    if (net !== network) {
      elsewhere.push({
        target: { module: m.id, tx: tx ?? 0, rx: rx ?? 0, protocol: null, obd: false },
        outcome: "other_network",
        dtcs: [],
        message: `On ${NETWORK_LABEL[net]}. ${NETWORK_HOW[net]}`,
      });
      continue;
    }
    if (tx === null || rx === null || tx === 0x7df) continue;
    const cat = catalogName(family, tx, rx);
    add({ tx, rx, protocol: tx === BMW_TESTER ? "KWP2000" : "UDS", label: m.id, name: cat?.name ?? null, named: true, sweep: null });
  }

  if (!CAN_NETWORKS.has(network)) {
    notes.push(`Connected on ${NETWORK_LABEL[network]}: only the engine's emissions codes can be read on this network, so no module sweep was run.`);
    return { family: id, network, probes: [], elsewhere, notes };
  }

  for (const m of family.modules) {
    const tx = parseHex(m.tx);
    const rx = parseHex(m.rx);
    if (tx === null || rx === null) continue;
    add({ tx, rx, protocol: tx === BMW_TESTER ? "KWP2000" : "UDS", label: m.abbr, name: m.name, named: true, sweep: null });
  }

  for (const sweepId of family.sweeps) {
    for (const a of sweepAddresses(sweepId)) {
      const cat = catalogName(family, a.tx, a.rx);
      add({
        tx: a.tx,
        rx: a.rx,
        protocol: a.protocol,
        label: cat?.abbr ?? unnamedLabel(a.tx, a.rx),
        name: cat?.name ?? null,
        named: Boolean(cat),
        sweep: sweepId,
      });
    }
  }

  if (family.subaddressed.length) {
    notes.push(
      `${family.subaddressed.length} known module${family.subaddressed.length === 1 ? "" : "s"} (${family.subaddressed
        .map((m) => m.abbr)
        .join(", ")}) need${family.subaddressed.length === 1 ? "s" : ""} sub-addressing, which RootCause can't do yet.`,
    );
  }
  if (family.networks_note) notes.push(family.networks_note);
  return { family: id, network, probes, elsewhere, notes };
}

export type DiagFn = (req: { tx: number; rx: number; protocol: DiagProtocol; payloadHex: string }) => Promise<{ positive: boolean }>;

export interface DiscoveryProgress {
  done: number;
  total: number;
  found: number;
  current: string;
}

export interface DiscoveryResult {
  found: ScanTarget[];
  notes: string[];
  /** Probes that were skipped because the connection can't send that id width. */
  skipped: number;
}

const WIDTH_ERROR = /expects (11|29)-bit/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Probes every planned address. Paced under the daemon's 20 requests/s limit;
 * a full 11-bit plus 29-bit sweep (~500 addresses) takes about half a minute.
 */
export async function discover(
  diag: DiagFn,
  plan: DiscoveryPlan,
  opts: { paceMs?: number; onProgress?: (p: DiscoveryProgress) => void; signal?: AbortSignal } = {},
): Promise<DiscoveryResult> {
  const pace = opts.paceMs ?? 55;
  const found: ScanTarget[] = [];
  const notes: string[] = [];
  const blockedWidth = new Set<"11" | "29">();
  let skipped = 0;

  for (let i = 0; i < plan.probes.length; i += 1) {
    if (opts.signal?.aborted) {
      notes.push(`Stopped after ${i} of ${plan.probes.length} addresses.`);
      break;
    }
    const p = plan.probes[i];
    opts.onProgress?.({ done: i, total: plan.probes.length, found: found.length, current: p.label });
    const width = is29Bit(p.tx) ? "29" : "11";
    if (blockedWidth.has(width)) {
      skipped += 1;
      continue;
    }
    const payloadHex = p.protocol === "KWP2000" ? "3E01" : "3E00";
    let answered = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await diag({ tx: p.tx, rx: p.rx, protocol: p.protocol, payloadHex });
        answered = true; // positive or negative: either way a module replied
        break;
      } catch (e) {
        if (e instanceof EdgeRequestError) {
          if (e.code === "TIMEOUT" || e.code === "CLIENT_TIMEOUT") break;
          if (/rate limit/i.test(e.message) && attempt === 0) {
            await sleep(250);
            continue;
          }
          if (WIDTH_ERROR.test(e.message)) {
            blockedWidth.add(width);
            skipped += 1;
            notes.push(
              width === "29"
                ? "29-bit modules weren't checked: this adapter is connected in 11-bit mode. Reconnect with ISO 15765 29-bit (or use a SocketCAN/J2534 adapter) to find them."
                : "11-bit modules weren't checked: this adapter is connected in 29-bit mode.",
            );
          }
        }
        break;
      }
    }
    if (answered) {
      found.push({
        module: p.label,
        tx: p.tx,
        rx: p.rx,
        protocol: p.protocol,
        obd: p.tx === 0x7e0 && p.rx === 0x7e8,
        name: p.name,
        discovered: !p.named,
      });
    }
    if (pace > 0) await sleep(pace);
  }
  opts.onProgress?.({ done: plan.probes.length, total: plan.probes.length, found: found.length, current: "" });

  // The engine's emissions codes are always worth asking for, even when the
  // engine ignores TesterPresent or sits at a non-standard enhanced address.
  if (!found.some((t) => t.obd)) {
    found.unshift({ module: "ENGINE", tx: 0x7e0, rx: 0x7e8, protocol: null, obd: true, name: "Emissions (OBD-II)", discovered: false });
  }
  return { found, notes, skipped };
}

/** How long a plan takes at the default pace, for the progress line. */
export function estimateSeconds(plan: DiscoveryPlan, paceMs = 55): number {
  return Math.ceil((plan.probes.length * (paceMs + 50)) / 1000);
}

export { hex, CATALOG };
