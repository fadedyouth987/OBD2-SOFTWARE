// A simulated ELM327 dongle on a simulated car, behind the same Transport interface
// as real Bluetooth. Used by the tests and by the app's demo mode. It answers the
// way the ELM327 datasheet describes (prompt ">", echo until ATE0, "?" for unknown
// commands, "NO DATA" when no module answers), so the driver is tested on the same
// text a real dongle sends. It is not a production adapter (PLAN.md Rule 2).

import type { Transport } from "./transport";

export interface SimCar {
  /** Stored, pending and permanent codes per module, as two-byte pairs ("0171"). */
  codes: Record<string, { stored: string[]; pending: string[]; permanent: string[] | null }>;
  vin: string;
  live: Record<number, number[]>;
  readiness: number[];
  freezeFrame: { code: string; values: Record<number, number[]> } | null;
}

export const DEMO_CAR: SimCar = {
  codes: {
    "7E8": { stored: ["0171", "0300"], pending: ["0420"], permanent: ["0171"] },
    "7E9": { stored: ["0700"], pending: [], permanent: [] },
  },
  vin: "6FPAAAJGCM4A12345",
  live: {
    0x0c: [0x0b, 0x40], // 720 rpm
    0x0d: [0x00],
    0x05: [0x7b], // 83 °C
    0x04: [0x33],
    0x11: [0x24],
    0x0b: [0x21],
    0x0f: [0x41],
    0x10: [0x01, 0x90],
    0x06: [0x8a],
    0x07: [0x94],
    0x0e: [0x8c],
    0x42: [0x36, 0xb0],
  },
  readiness: [0x82, 0x07, 0x65, 0x01],
  freezeFrame: { code: "0171", values: { 0x0c: [0x0c, 0x80], 0x05: [0x7a], 0x06: [0x9a] } },
};

export interface EmulatorOptions {
  /** Drop the link after this many commands (to test a Bluetooth drop mid-scan). */
  dropAfter?: number;
  /** Commands (without spaces) that answer "NO DATA". */
  noData?: string[];
  /** Commands the clone doesn't know (answers "?"). */
  unknown?: string[];
  /** Echo commands even after ATE0, as some clones do. */
  stickyEcho?: boolean;
  /** Split every reply into small chunks, as BLE notifications do. */
  chunkSize?: number;
}

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0").toUpperCase()).join(" ");

/** Wrap a payload in ISO-TP single or multi frames with an 11-bit header. */
function canFrames(ecu: string, payload: number[]): string[] {
  if (payload.length <= 7) return [`${ecu} ${hex([payload.length, ...payload, ...Array(7 - payload.length).fill(0)])}`];
  const lines = [`${ecu} ${hex([0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)])}`];
  let seq = 1;
  for (let i = 6; i < payload.length; i += 7) {
    const part = payload.slice(i, i + 7);
    lines.push(`${ecu} ${hex([0x20 | (seq & 0x0f), ...part, ...Array(7 - part.length).fill(0)])}`);
    seq += 1;
  }
  return lines;
}

const pair = (code: string) => [Number.parseInt(code.slice(0, 2), 16), Number.parseInt(code.slice(2, 4), 16)];

export class Elm327Emulator implements Transport {
  readonly label = "Demo car (simulated dongle)";
  private dataListeners = new Set<(c: string) => void>();
  private dropListeners = new Set<(w: string) => void>();
  private echo = true;
  private count = 0;
  private dead = false;
  readonly sent: string[] = [];

  constructor(
    private readonly car: SimCar = DEMO_CAR,
    private readonly opts: EmulatorOptions = {},
  ) {}

  onData(listener: (chunk: string) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onDisconnect(listener: (why: string) => void) {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  async close() {
    this.dead = true;
  }

  async write(text: string): Promise<void> {
    if (this.dead) throw new Error("closed");
    const cmd = text.replace(/\s+/g, "").toUpperCase();
    this.sent.push(cmd);
    this.count += 1;
    if (this.opts.dropAfter !== undefined && this.count > this.opts.dropAfter) {
      this.dead = true;
      setTimeout(() => this.dropListeners.forEach((l) => l("Bluetooth link lost")), 0);
      return;
    }
    const lines = this.answer(cmd);
    const echo = this.echo || this.opts.stickyEcho ? `${cmd}\r` : "";
    this.emit(`${echo}${lines.join("\r")}\r\r>`);
  }

  private emit(text: string) {
    const size = this.opts.chunkSize ?? text.length;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    setTimeout(() => chunks.forEach((c) => this.dataListeners.forEach((l) => l(c))), 0);
  }

  private answer(cmd: string): string[] {
    if (this.opts.unknown?.includes(cmd)) return ["?"];
    if (this.opts.noData?.includes(cmd)) return ["NO DATA"];
    if (cmd === "ATZ") {
      this.echo = true;
      return ["", "ELM327 v1.5"];
    }
    if (cmd === "ATE0") {
      this.echo = false;
      return ["OK"];
    }
    if (/^AT(L0|S0|H1|SP0|AT[0-2]|CAF1|ST..)$/.test(cmd)) return ["OK"];
    if (cmd === "ATRV") return ["12.6V"];
    if (cmd === "ATDPN") return ["A6"];
    if (cmd === "ATI") return ["ELM327 v1.5"];
    if (cmd.startsWith("AT") || cmd.startsWith("ST")) return ["?"];

    const mode = cmd.slice(0, 2);
    const modules = Object.entries(this.car.codes);
    if (mode === "03" || mode === "07" || mode === "0A") {
      const key = mode === "03" ? "stored" : mode === "07" ? "pending" : "permanent";
      const out: string[] = [];
      for (const [ecu, c] of modules) {
        const list = c[key];
        if (list === null) continue;
        out.push(...canFrames(ecu, [Number.parseInt(mode, 16) + 0x40, list.length, ...list.flatMap(pair)]));
      }
      return out.length ? out : ["NO DATA"];
    }
    if (cmd === "0902") {
      return canFrames("7E8", [0x49, 0x02, 0x01, ...[...this.car.vin].map((ch) => ch.charCodeAt(0))]);
    }
    if (mode === "01") {
      const pids = (cmd.slice(2).match(/../g) ?? []).map((p) => Number.parseInt(p, 16));
      const body: number[] = [0x41];
      for (const pid of pids) {
        if (pid % 0x20 === 0) {
          const known = [0x01, ...Object.keys(this.car.live).map(Number)];
          const supported = known.filter((p) => p > pid && p < pid + 0x20);
          if (known.some((p) => p > pid + 0x20)) supported.push(pid + 0x20);
          if (!supported.length && pid !== 0) continue;
          const bits = [0, 0, 0, 0];
          for (const p of supported) bits[Math.floor((p - pid - 1) / 8)] |= 0x80 >> ((p - pid - 1) % 8);
          body.push(pid, ...bits);
        } else if (pid === 0x01) {
          body.push(0x01, ...this.car.readiness);
        } else if (this.car.live[pid]) {
          body.push(pid, ...this.car.live[pid]);
        }
      }
      return body.length > 1 ? canFrames("7E8", body) : ["NO DATA"];
    }
    if (mode === "02") {
      const ff = this.car.freezeFrame;
      if (!ff) return ["NO DATA"];
      const pid = Number.parseInt(cmd.slice(2, 4), 16);
      if (pid === 0x02) return canFrames("7E8", [0x42, 0x02, 0x00, ...pair(ff.code)]);
      const v = ff.values[pid];
      return v ? canFrames("7E8", [0x42, pid, 0x00, ...v]) : ["NO DATA"];
    }
    return ["?"];
  }
}
