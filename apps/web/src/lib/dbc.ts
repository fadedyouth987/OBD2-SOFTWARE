// Minimal DBC (Vector CAN database) reader: messages (BO_) and signals (SG_),
// enough to decode live frames. Multiplexed signals are listed but only the
// multiplexor and plain signals are decoded.

export interface DbcSignal {
  name: string;
  startBit: number;
  length: number;
  littleEndian: boolean;
  signed: boolean;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  multiplex: "plain" | "multiplexor" | "multiplexed";
}

export interface DbcMessage {
  /** CAN id without the DBC extended flag (bit 31). */
  id: number;
  extended: boolean;
  name: string;
  dlc: number;
  signals: DbcSignal[];
}

export interface Dbc {
  messages: Map<number, DbcMessage>;
  warnings: string[];
}

const BO_RE = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/;
const SG_RE =
  /^SG_\s+(\w+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*\[\s*([-+0-9.eE]+)\s*\|\s*([-+0-9.eE]+)\s*\]\s*"([^"]*)"/;

export function parseDbc(text: string): Dbc {
  const messages = new Map<number, DbcMessage>();
  const warnings: string[] = [];
  let current: DbcMessage | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith("BO_ ")) {
      const m = BO_RE.exec(line);
      if (!m) {
        warnings.push(`Line ${i + 1}: unreadable message definition`);
        current = null;
        continue;
      }
      const raw = Number(m[1]);
      // DBC marks extended ids with bit 31; plain ids above 0x7FF are 29-bit too.
      const extended = raw >= 0x80000000 || raw > 0x7ff;
      const id = raw % 0x80000000 & 0x1fffffff;
      current = { id, extended, name: m[2], dlc: Number(m[3]), signals: [] };
      messages.set(id, current);
    } else if (line.startsWith("SG_ ")) {
      if (!current) continue;
      const s = SG_RE.exec(line);
      if (!s) {
        warnings.push(`Line ${i + 1}: unreadable signal in ${current.name}`);
        continue;
      }
      const length = Number(s[4]);
      if (length < 1 || length > 64) {
        warnings.push(`Line ${i + 1}: signal ${s[1]} has an invalid length`);
        continue;
      }
      current.signals.push({
        name: s[1],
        multiplex: !s[2] ? "plain" : s[2] === "M" ? "multiplexor" : "multiplexed",
        startBit: Number(s[3]),
        length,
        littleEndian: s[5] === "1",
        signed: s[6] === "-",
        factor: Number(s[7]),
        offset: Number(s[8]),
        min: Number(s[9]),
        max: Number(s[10]),
        unit: s[11],
      });
    } else {
      // Any other line (blank or a new keyword) ends the message block.
      current = null;
    }
  }
  return { messages, warnings };
}

function bit(bytes: number[], pos: number): number {
  const b = bytes[pos >> 3];
  return b === undefined ? -1 : (b >> (pos & 7)) & 1;
}

/** Raw (unscaled) value of a signal, or null when the frame is too short. */
export function rawValue(sig: DbcSignal, bytes: number[]): bigint | null {
  let raw = BigInt(0);
  if (sig.littleEndian) {
    for (let i = sig.length - 1; i >= 0; i -= 1) {
      const v = bit(bytes, sig.startBit + i);
      if (v < 0) return null;
      raw = (raw << BigInt(1)) | BigInt(v);
    }
  } else {
    // Motorola: start bit is the MSB in DBC's sawtooth numbering.
    let pos = sig.startBit;
    for (let i = 0; i < sig.length; i += 1) {
      const v = bit(bytes, pos);
      if (v < 0) return null;
      raw = (raw << BigInt(1)) | BigInt(v);
      pos = pos % 8 === 0 ? pos + 15 : pos - 1;
    }
  }
  if (sig.signed && ((raw >> BigInt(sig.length - 1)) & BigInt(1)) === BigInt(1)) raw -= BigInt(1) << BigInt(sig.length);
  return raw;
}

export function decodeSignal(sig: DbcSignal, bytes: number[]): number | null {
  const raw = rawValue(sig, bytes);
  return raw === null ? null : Number(raw) * sig.factor + sig.offset;
}

/** Bit positions (0..63, byte*8+bit) a signal occupies, for the bit matrix. */
export function signalBits(sig: DbcSignal): number[] {
  const out: number[] = [];
  if (sig.littleEndian) {
    for (let i = 0; i < sig.length; i += 1) out.push(sig.startBit + i);
  } else {
    let pos = sig.startBit;
    for (let i = 0; i < sig.length; i += 1) {
      out.push(pos);
      pos = pos % 8 === 0 ? pos + 15 : pos - 1;
    }
  }
  return out;
}
