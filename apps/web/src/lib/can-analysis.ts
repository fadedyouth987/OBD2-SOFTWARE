// Live CAN aggregation and bit-change analysis (baseline vs action).

import { bytesOf } from "@/lib/diag";

export interface IdStats {
  id: number;
  extended: boolean;
  count: number;
  firstUs: number;
  lastUs: number;
  data: number[];
  dlc: number;
  /** Per-byte time (ms, local clock) of the last change, for highlighting. */
  changedAt: number[];
  /** Bits that have changed since the capture started (64-bit as 8 bytes). */
  toggled: number[];
}

export interface FrameIn {
  timestamp_us: number;
  can_id: number;
  is_extended: boolean;
  dlc: number;
  data_hex: string;
}

export function ingest(map: Map<number, IdStats>, frames: FrameIn[], nowMs: number): void {
  for (const f of frames) {
    const data = bytesOf(f.data_hex);
    const s = map.get(f.can_id);
    if (!s) {
      map.set(f.can_id, {
        id: f.can_id,
        extended: f.is_extended,
        count: 1,
        firstUs: f.timestamp_us,
        lastUs: f.timestamp_us,
        data,
        dlc: f.dlc,
        changedAt: data.map(() => 0),
        toggled: new Array(8).fill(0),
      });
      continue;
    }
    for (let i = 0; i < Math.max(data.length, s.data.length); i += 1) {
      const diff = (data[i] ?? 0) ^ (s.data[i] ?? 0);
      if (diff) {
        s.toggled[i] |= diff;
        s.changedAt[i] = nowMs;
      }
    }
    s.count += 1;
    s.lastUs = f.timestamp_us;
    s.data = data;
    s.dlc = f.dlc;
  }
}

/** Frames per second over the whole capture. */
export function rateHz(s: IdStats): number {
  const span = (s.lastUs - s.firstUs) / 1e6;
  return span > 0 ? (s.count - 1) / span : 0;
}

export type BitClass = "static" | "noise" | "candidate" | "unused";

/**
 * Classifies each bit of an id: "noise" toggled during the baseline (counters,
 * checksums, sensor jitter), "candidate" toggled only during the action, and
 * "static" never toggled. Bits past the DLC are "unused".
 */
export function classifyBits(baseline: IdStats | undefined, action: IdStats | undefined, dlc: number): BitClass[] {
  const out: BitClass[] = [];
  for (let byte = 0; byte < 8; byte += 1) {
    for (let b = 0; b < 8; b += 1) {
      if (byte >= dlc) {
        out.push("unused");
        continue;
      }
      const mask = 1 << b;
      const inBase = ((baseline?.toggled[byte] ?? 0) & mask) !== 0;
      const inAction = ((action?.toggled[byte] ?? 0) & mask) !== 0;
      out.push(inBase ? "noise" : inAction ? "candidate" : "static");
    }
  }
  return out;
}

/** Ids with at least one candidate bit, most candidates first. */
export function candidateIds(baseline: Map<number, IdStats>, action: Map<number, IdStats>): { id: number; bits: number }[] {
  const out: { id: number; bits: number }[] = [];
  for (const [id, a] of action) {
    const bits = classifyBits(baseline.get(id), a, a.dlc).filter((c) => c === "candidate").length;
    if (bits) out.push({ id, bits });
  }
  return out.sort((x, y) => y.bits - x.bits || x.id - y.id);
}
