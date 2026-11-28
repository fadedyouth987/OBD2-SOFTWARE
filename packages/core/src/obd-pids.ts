// OBD-II mode 01 decoding (SAE J1979): live values, supported-PID bitmaps and
// readiness monitors. Pure functions over response bytes; no I/O.

export interface PidDef {
  pid: number;
  name: string;
  unit: string;
  /** Data bytes after "41 <pid>". */
  bytes: number;
  decode: (d: number[]) => number;
}

const pct = (a: number) => (a * 100) / 255;
const trim = (a: number) => ((a - 128) * 100) / 128;

/** The PIDs the app shows. Order is display order. */
export const PIDS: PidDef[] = [
  { pid: 0x0c, name: "Engine speed", unit: "rpm", bytes: 2, decode: ([a, b]) => (a * 256 + b) / 4 },
  { pid: 0x0d, name: "Vehicle speed", unit: "km/h", bytes: 1, decode: ([a]) => a },
  { pid: 0x05, name: "Coolant temperature", unit: "°C", bytes: 1, decode: ([a]) => a - 40 },
  { pid: 0x04, name: "Engine load", unit: "%", bytes: 1, decode: ([a]) => pct(a) },
  { pid: 0x11, name: "Throttle position", unit: "%", bytes: 1, decode: ([a]) => pct(a) },
  { pid: 0x0b, name: "Intake manifold pressure", unit: "kPa", bytes: 1, decode: ([a]) => a },
  { pid: 0x0f, name: "Intake air temperature", unit: "°C", bytes: 1, decode: ([a]) => a - 40 },
  { pid: 0x10, name: "Mass air flow", unit: "g/s", bytes: 2, decode: ([a, b]) => (a * 256 + b) / 100 },
  { pid: 0x06, name: "Short-term fuel trim (bank 1)", unit: "%", bytes: 1, decode: ([a]) => trim(a) },
  { pid: 0x07, name: "Long-term fuel trim (bank 1)", unit: "%", bytes: 1, decode: ([a]) => trim(a) },
  { pid: 0x08, name: "Short-term fuel trim (bank 2)", unit: "%", bytes: 1, decode: ([a]) => trim(a) },
  { pid: 0x09, name: "Long-term fuel trim (bank 2)", unit: "%", bytes: 1, decode: ([a]) => trim(a) },
  { pid: 0x0e, name: "Timing advance", unit: "°", bytes: 1, decode: ([a]) => a / 2 - 64 },
  { pid: 0x2f, name: "Fuel level", unit: "%", bytes: 1, decode: ([a]) => pct(a) },
  { pid: 0x33, name: "Barometric pressure", unit: "kPa", bytes: 1, decode: ([a]) => a },
  { pid: 0x42, name: "Control module voltage", unit: "V", bytes: 2, decode: ([a, b]) => (a * 256 + b) / 1000 },
  { pid: 0x46, name: "Ambient air temperature", unit: "°C", bytes: 1, decode: ([a]) => a - 40 },
  { pid: 0x5c, name: "Engine oil temperature", unit: "°C", bytes: 1, decode: ([a]) => a - 40 },
  { pid: 0x1f, name: "Run time since engine start", unit: "s", bytes: 2, decode: ([a, b]) => a * 256 + b },
];

export const PID_BY_ID: ReadonlyMap<number, PidDef> = new Map(PIDS.map((p) => [p.pid, p]));

export interface PidValue {
  pid: number;
  name: string;
  unit: string;
  value: number;
}

/**
 * Decode a mode 01 reply ("41 pid data [pid data ...]"); a CAN reply may carry up to
 * six PIDs. Stops at the first PID it doesn't know (it can't tell how long it is).
 */
export function decodeMode01(payload: number[]): PidValue[] {
  if (payload[0] !== 0x41) return [];
  const out: PidValue[] = [];
  let i = 1;
  while (i < payload.length) {
    const def = PID_BY_ID.get(payload[i]);
    if (!def) break;
    const data = payload.slice(i + 1, i + 1 + def.bytes);
    if (data.length < def.bytes) break;
    out.push({ pid: def.pid, name: def.name, unit: def.unit, value: Math.round(def.decode(data) * 100) / 100 });
    i += 1 + def.bytes;
  }
  return out;
}

/**
 * "Supported PIDs" bitmap (01 00, 01 20, 01 40 ...): bit 7 of the first byte is
 * base+1. Returns the supported PID numbers.
 */
export function decodeSupported(base: number, bitmap: number[]): number[] {
  const out: number[] = [];
  for (let byte = 0; byte < 4; byte++) {
    for (let bit = 0; bit < 8; bit++) {
      if ((bitmap[byte] ?? 0) & (0x80 >> bit)) out.push(base + byte * 8 + bit + 1);
    }
  }
  return out;
}

export type MonitorState = "complete" | "incomplete" | "not supported";

export interface Readiness {
  milOn: boolean;
  storedCodes: number;
  /** Spark (petrol) or compression (diesel) ignition: decides which monitors exist. */
  ignition: "spark" | "compression";
  monitors: { name: string; state: MonitorState }[];
}

const CONTINUOUS = ["Misfire", "Fuel system", "Components"];
const SPARK = ["Catalyst", "Heated catalyst", "Evaporative system", "Secondary air", "A/C refrigerant", "Oxygen sensor", "Oxygen sensor heater", "EGR system"];
const COMPRESSION = ["NMHC catalyst", "NOx/SCR aftertreatment", "Reserved", "Boost pressure", "Reserved", "Exhaust gas sensor", "Particulate filter", "EGR/VVT system"];

/** Mode 01 PID 01 (four data bytes A B C D). */
export function decodeReadiness([a, b, c, d]: number[]): Readiness {
  const ignition = b & 0x08 ? "compression" : "spark";
  const monitors: Readiness["monitors"] = CONTINUOUS.map((name, i) => ({
    name,
    state: !(b & (1 << i)) ? "not supported" : b & (0x10 << i) ? "incomplete" : "complete",
  }));
  const names = ignition === "spark" ? SPARK : COMPRESSION;
  names.forEach((name, i) => {
    if (name === "Reserved") return;
    monitors.push({
      name,
      state: !(c & (1 << i)) ? "not supported" : d & (1 << i) ? "incomplete" : "complete",
    });
  });
  return { milOn: (a & 0x80) !== 0, storedCodes: a & 0x7f, ignition, monitors };
}
