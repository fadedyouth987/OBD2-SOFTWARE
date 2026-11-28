// The module catalogue (packages/schemas/module_catalog.json): names and
// diagnostic addresses per make family, and the address ranges the scanner
// sweeps to find modules the catalogue doesn't list.

import catalogJson from "@obd2/schemas/module_catalog.json";

export type Addressing = "normal" | "iso29" | "bmw_extended";

export interface CatalogModule {
  abbr: string;
  name: string;
  tx: string;
  rx: string | null;
  source: string;
  note: string | null;
}

export interface CatalogSweep {
  label: string;
  addressing: Addressing;
  from: string;
  to: string;
  rx_offset: number | null;
}

export interface CatalogFamily {
  label: string;
  sweeps: string[];
  modules: CatalogModule[];
  subaddressed: (CatalogModule & { subaddress: string })[];
  networks_note: string | null;
}

export interface ModuleCatalog {
  catalog_version: string;
  probe: { service: string; payload_hex: string; note: string };
  sweeps: Record<string, CatalogSweep>;
  families: Record<string, CatalogFamily>;
  sources: Record<string, { title: string; url: string | null }>;
}

export const CATALOG = catalogJson as unknown as ModuleCatalog;

export const BMW_TESTER = 0x6f1;

export function hex(n: number): string {
  return `0x${n.toString(16).toUpperCase()}`;
}

export function parseHex(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(s.replace(/^0x/i, ""), 16);
  return Number.isFinite(n) ? n : null;
}

/** The family for a registry platform; unknown or missing falls back to generic discovery. */
export function familyFor(name: string | null | undefined): { id: string; family: CatalogFamily } {
  const id = name && CATALOG.families[name] ? name : "generic";
  return { id, family: CATALOG.families[id] };
}

export interface Address {
  tx: number;
  rx: number;
  /** The scan protocol for enhanced reads at this address. */
  protocol: "UDS" | "KWP2000";
  /** Which sweep produced it (null for a named catalogue or registry entry). */
  sweep: string | null;
}

/** Every address a sweep covers, in order. The functional OBD id 0x7DF is never probed. */
export function sweepAddresses(sweepId: string): Address[] {
  const s = CATALOG.sweeps[sweepId];
  if (!s) return [];
  const from = parseHex(s.from) ?? 0;
  const to = parseHex(s.to) ?? -1;
  const out: Address[] = [];
  for (let a = from; a <= to; a += 1) {
    if (s.addressing === "normal") {
      if (a === 0x7df) continue;
      const rx = a + (s.rx_offset ?? 8);
      if (rx < 0 || rx > 0x7ff) continue;
      out.push({ tx: a, rx, protocol: "UDS", sweep: sweepId });
    } else if (s.addressing === "iso29") {
      out.push({ tx: (0x18da00f1 | (a << 8)) >>> 0, rx: (0x18daf100 | a) >>> 0, protocol: "UDS", sweep: sweepId });
    } else {
      out.push({ tx: BMW_TESTER, rx: 0x600 + a, protocol: "KWP2000", sweep: sweepId });
    }
  }
  return out;
}

export function is29Bit(id: number): boolean {
  return id > 0x7ff;
}

/** A readable label for an address nobody has named. */
export function unnamedLabel(tx: number, rx: number): string {
  if (tx === BMW_TESTER) return `Module at BMW address ${hex(rx - 0x600)}`;
  if (is29Bit(tx)) return `Module at 29-bit address ${hex((tx >>> 8) & 0xff)}`;
  return `Module at ${hex(tx)}`;
}

/** Catalogue name for an address in this family, if it has one. */
export function catalogName(family: CatalogFamily, tx: number, rx: number): CatalogModule | null {
  return family.modules.find((m) => parseHex(m.tx) === tx && parseHex(m.rx) === rx) ?? null;
}
