// Read-only diagnostics over an initialised Elm327: codes per module, readiness,
// VIN, freeze frame and live data.
//
// A read that fails (timeout, dropped link, bus error, garbled reply) is never shown
// as "no codes". It is reported as failed, and the whole scan as incomplete
// (PLAN.md Rule 6: an unsupported or failed check never reports a pass).

import { dtcText, parseObdDtcs, parseVin, type ReadDtc } from "@obd2/core/diag";
import { decodeMode01, decodeReadiness, decodeSupported, type PidValue, type Readiness } from "@obd2/core/obd-pids";
import { busError, Elm327, ElmError } from "./elm327";
import { FrameError, parseReplyLines, type ModuleReply } from "./frames";

export type ReadOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "not supported" }
  | { status: "failed"; reason: string };

/** Module address to a name people recognise (CAN 11-bit / 29-bit defaults). */
export function moduleName(ecu: string): string {
  const id = ecu.toUpperCase();
  if (id === "7E8" || id.endsWith("F110") || id === "10") return "Engine";
  if (id === "7E9" || id.endsWith("F118") || id === "18") return "Transmission";
  return `Module ${id}`;
}

async function request(elm: Elm327, cmd: string): Promise<ReadOutcome<ModuleReply[]>> {
  if (!elm.info) return { status: "failed", reason: "The dongle isn't set up yet." };
  let lines: string[];
  try {
    lines = await elm.send(cmd);
  } catch (e) {
    return { status: "failed", reason: e instanceof ElmError ? e.message : String(e) };
  }
  const err = busError(lines);
  if (err === "NO DATA") return { status: "not supported" };
  if (err) return { status: "failed", reason: err };
  try {
    const replies = parseReplyLines(lines, elm.info.bus);
    if (replies.length === 0) return { status: "failed", reason: "The car's reply couldn't be read." };
    return { status: "ok", value: replies };
  } catch (e) {
    return { status: "failed", reason: e instanceof FrameError ? e.message : String(e) };
  }
}

export interface ModuleCodes {
  ecu: string;
  module: string;
  codes: ReadDtc[];
}

export interface CodeScan {
  /** "complete" only when stored codes were read from every module that answered. */
  status: "complete" | "incomplete";
  stored: ReadOutcome<ModuleCodes[]>;
  pending: ReadOutcome<ModuleCodes[]>;
  permanent: ReadOutcome<ModuleCodes[]>;
}

async function readMode(elm: Elm327, mode: 0x03 | 0x07 | 0x0a): Promise<ReadOutcome<ModuleCodes[]>> {
  const cmd = mode.toString(16).padStart(2, "0").toUpperCase();
  const r = await request(elm, cmd);
  if (r.status !== "ok") return r;
  const modules: ModuleCodes[] = [];
  for (const reply of r.value) {
    if (reply.payload[0] === 0x7f) continue; // this module refused the mode
    if (reply.payload[0] !== mode + 0x40) return { status: "failed", reason: `Unexpected reply from ${moduleName(reply.ecu)}.` };
    const hex = reply.payload.map((b) => b.toString(16).padStart(2, "0")).join("");
    modules.push({ ecu: reply.ecu, module: moduleName(reply.ecu), codes: parseObdDtcs(mode, hex) });
  }
  if (modules.length === 0) return { status: "not supported" };
  return { status: "ok", value: modules };
}

export async function scanCodes(elm: Elm327): Promise<CodeScan> {
  const stored = await readMode(elm, 0x03);
  const pending = await readMode(elm, 0x07);
  const permanent = await readMode(elm, 0x0a);
  // Mode 03 is mandatory for every OBD-II car: "not supported" there means no answer.
  return { status: stored.status === "ok" ? "complete" : "incomplete", stored, pending, permanent };
}

export async function readReadiness(elm: Elm327): Promise<ReadOutcome<Readiness>> {
  const r = await request(elm, "0101");
  if (r.status !== "ok") return r;
  const engine = r.value.find((m) => m.payload[0] === 0x41 && m.payload[1] === 0x01);
  if (!engine || engine.payload.length < 6) return { status: "failed", reason: "Readiness reply was too short." };
  return { status: "ok", value: decodeReadiness(engine.payload.slice(2, 6)) };
}

export async function readVin(elm: Elm327): Promise<ReadOutcome<string>> {
  const r = await request(elm, "0902");
  if (r.status !== "ok") return r;
  for (const m of r.value) {
    const vin = parseVin(m.payload.map((b) => b.toString(16).padStart(2, "0")).join(""));
    if (vin) return { status: "ok", value: vin };
  }
  return { status: "not supported" };
}

/** Supported mode 01 PIDs from the engine module (01 00 / 20 / 40 ...). */
export async function readSupportedPids(elm: Elm327): Promise<ReadOutcome<number[]>> {
  const out: number[] = [];
  for (let base = 0x00; base <= 0xa0; base += 0x20) {
    const r = await request(elm, `01${base.toString(16).padStart(2, "0").toUpperCase()}`);
    if (r.status !== "ok") return out.length ? { status: "ok", value: out } : r;
    const m = r.value.find((x) => x.payload[0] === 0x41 && x.payload[1] === base);
    if (!m) break;
    const pids = decodeSupported(base, m.payload.slice(2, 6));
    out.push(...pids.filter((p) => p % 0x20 !== 0));
    if (!pids.includes(base + 0x20)) break;
  }
  return { status: "ok", value: out };
}

/**
 * One round of live data. On CAN, up to six PIDs go in one request; older buses
 * take one PID per request.
 */
export async function readLive(elm: Elm327, pids: number[]): Promise<ReadOutcome<PidValue[]>> {
  if (!elm.info) return { status: "failed", reason: "The dongle isn't set up yet." };
  const perRequest = elm.info.bus === "legacy" ? 1 : 6;
  const values: PidValue[] = [];
  for (let i = 0; i < pids.length; i += perRequest) {
    const chunk = pids.slice(i, i + perRequest);
    const cmd = `01${chunk.map((p) => p.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
    const r = await request(elm, cmd);
    if (r.status === "failed") return r;
    if (r.status === "ok") {
      for (const m of r.value) values.push(...decodeMode01(m.payload));
    }
  }
  return { status: "ok", value: values };
}

export interface FreezeFrame {
  /** The code that stored the freeze frame, if the car reports it. */
  code: string | null;
  values: PidValue[];
}

export async function readFreezeFrame(elm: Elm327, pids: number[]): Promise<ReadOutcome<FreezeFrame>> {
  const first = await request(elm, "020200");
  if (first.status !== "ok") return first;
  const m = first.value.find((x) => x.payload[0] === 0x42 && x.payload[1] === 0x02);
  const hi = m?.payload[3] ?? 0;
  const lo = m?.payload[4] ?? 0;
  if (!m || (hi === 0 && lo === 0)) return { status: "not supported" };
  const values: PidValue[] = [];
  for (const pid of pids) {
    const r = await request(elm, `02${pid.toString(16).padStart(2, "0").toUpperCase()}00`);
    if (r.status === "failed") return r;
    if (r.status !== "ok") continue;
    for (const reply of r.value) {
      if (reply.payload[0] !== 0x42) continue;
      // 42 pid frame data... -> reuse the mode 01 decoder on "41 pid data".
      values.push(...decodeMode01([0x41, reply.payload[1], ...reply.payload.slice(3)]));
    }
  }
  return { status: "ok", value: { code: dtcText(hi, lo), values } };
}
