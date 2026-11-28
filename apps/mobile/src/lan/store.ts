// The workshop PC this phone is paired with, kept in the phone's secure storage
// (Android Keystore-backed). The device secret never leaves the phone except in
// the Authorization header of a connection whose certificate matched the pin.

export interface PairedPc {
  host: string;
  port: number;
  fingerprint: string;
  daemonId: string;
  name: string;
  deviceId: string;
  deviceSecret: string;
  pairedAt: string;
}

export interface SecureKv {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export const PC_KEY = "rootcause.lan.pc";

function valid(p: unknown): p is PairedPc {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.host === "string" &&
    typeof o.port === "number" &&
    typeof o.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(o.fingerprint) &&
    typeof o.daemonId === "string" &&
    typeof o.name === "string" &&
    typeof o.deviceId === "string" &&
    /^lan_[0-9a-f]{16}$/.test(o.deviceId) &&
    typeof o.deviceSecret === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(o.deviceSecret) &&
    typeof o.pairedAt === "string"
  );
}

type Listener = (pc: PairedPc | null) => void;

/** Loads, saves and forgets the paired PC, and tells listeners when it changes. */
export class PcStore {
  private listeners = new Set<Listener>();
  private cached: PairedPc | null | undefined;

  constructor(private readonly kv: SecureKv) {}

  async load(): Promise<PairedPc | null> {
    if (this.cached !== undefined) return this.cached;
    let pc: PairedPc | null = null;
    try {
      const raw = await this.kv.getItemAsync(PC_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      pc = valid(parsed) ? parsed : null;
    } catch {
      pc = null;
    }
    this.cached = pc;
    return pc;
  }

  /** The last loaded value (undefined before the first load). */
  current(): PairedPc | null | undefined {
    return this.cached;
  }

  async save(pc: PairedPc): Promise<void> {
    if (!valid(pc)) throw new Error("bad pairing");
    await this.kv.setItemAsync(PC_KEY, JSON.stringify(pc));
    this.cached = pc;
    this.listeners.forEach((l) => l(pc));
  }

  async forget(): Promise<void> {
    await this.kv.deleteItemAsync(PC_KEY);
    this.cached = null;
    this.listeners.forEach((l) => l(null));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

/** What the web app may know about the PC: never the device secret. */
export function publicInfo(pc: PairedPc | null): { paired: boolean; name?: string; host?: string; port?: number; fingerprint?: string } {
  if (!pc) return { paired: false };
  return { paired: true, name: pc.name, host: pc.host, port: pc.port, fingerprint: pc.fingerprint.slice(0, 16) };
}
