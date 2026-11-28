// ELM327 driver: sends one command at a time, waits for the ">" prompt, and gives
// back the reply lines. Every command goes through the send guard first.

import { checkCommand } from "./sendGuard";
import type { Transport } from "./transport";
import { busForProtocol, type Bus } from "./frames";

/** A reply the dongle uses to say the car didn't answer or the bus failed. */
export const BUS_ERRORS = ["NO DATA", "CAN ERROR", "BUS INIT", "BUS ERROR", "STOPPED", "UNABLE TO CONNECT", "FB ERROR", "DATA ERROR", "BUFFER FULL", "LV RESET", "ERR"];

export class ElmError extends Error {
  constructor(
    message: string,
    readonly kind: "refused" | "timeout" | "disconnected" | "bus" | "unsupported-dongle",
  ) {
    super(message);
  }
}

export interface ElmInfo {
  version: string;
  protocol: string;
  bus: Bus;
  voltage: string | null;
}

// Required: without these the replies can't be parsed.
const REQUIRED_INIT = ["ATE0", "ATL0", "ATS0", "ATH1", "ATSP0"];

export class Elm327 {
  private buffer = "";
  private waiter: ((text: string) => void) | null = null;
  private failWaiter: ((e: ElmError) => void) | null = null;
  private dropped: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly unsubs: (() => void)[] = [];
  info: ElmInfo | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly timeoutMs = 5000,
  ) {
    this.unsubs.push(
      transport.onData((chunk) => {
        this.buffer += chunk;
        const end = this.buffer.indexOf(">");
        if (end >= 0 && this.waiter) {
          const text = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          const w = this.waiter;
          this.waiter = null;
          w(text);
        }
      }),
      transport.onDisconnect((why) => {
        this.dropped = why || "The dongle disconnected.";
        // Fail the command in flight now rather than waiting for its timeout.
        this.failWaiter?.(new ElmError(this.dropped, "disconnected"));
      }),
    );
  }

  get connected(): boolean {
    return this.dropped === null;
  }

  /** Send one command and return its reply lines (echo and "SEARCHING..." removed). */
  send(command: string): Promise<string[]> {
    const run = async () => {
      const verdict = checkCommand(command);
      if (!verdict.ok) throw new ElmError(verdict.reason, "refused");
      if (this.dropped) throw new ElmError(this.dropped, "disconnected");
      this.buffer = "";
      const reply = new Promise<string>((resolve, reject) => {
        const settle = () => {
          clearTimeout(timer);
          this.waiter = null;
          this.failWaiter = null;
        };
        const timer = setTimeout(() => {
          settle();
          reject(new ElmError(`No reply to ${command} from the dongle.`, "timeout"));
        }, this.timeoutMs);
        this.waiter = (text) => {
          settle();
          resolve(text);
        };
        this.failWaiter = (e) => {
          settle();
          reject(e);
        };
      });
      await this.transport.write(`${command}\r`);
      const text = await reply;
      const sent = command.replace(/\s+/g, "").toUpperCase();
      return text
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l && l.replace(/\s+/g, "").toUpperCase() !== sent && !/^SEARCHING/i.test(l));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Reset and configure the dongle. Throws "unsupported-dongle" if a required setting is refused. */
  async init(): Promise<ElmInfo> {
    const reset = await this.send("ATZ");
    const version = reset.find((l) => /ELM|STN|OBD/i.test(l)) ?? reset.join(" ");
    for (const cmd of REQUIRED_INIT) {
      const r = await this.send(cmd);
      if (r.includes("?")) throw new ElmError(`This dongle doesn't accept ${cmd}, so RootCause can't read its replies.`, "unsupported-dongle");
    }
    // Optional: adaptive timing helps slow clones; "?" just means not supported.
    await this.send("ATAT1").catch(() => undefined);
    const volts = await this.send("ATRV").catch(() => [] as string[]);
    // Wake the bus so ATDPN reports the protocol the car actually uses.
    await this.send("0100").catch(() => undefined);
    const dpn = (await this.send("ATDPN"))[0] ?? "";
    this.info = {
      version,
      protocol: dpn,
      bus: busForProtocol(dpn),
      voltage: volts.find((v) => /\d+(\.\d+)?V/i.test(v)) ?? null,
    };
    return this.info;
  }

  async close(): Promise<void> {
    this.unsubs.forEach((u) => u());
    await this.transport.close();
  }
}

/** True if the reply lines are a dongle/bus error rather than data. */
export function busError(lines: string[]): string | null {
  const joined = lines.join(" ").toUpperCase();
  if (lines.length === 0) return "No reply";
  if (lines.includes("?")) return "Dongle didn't understand the request";
  return BUS_ERRORS.find((e) => joined.includes(e)) ?? null;
}
