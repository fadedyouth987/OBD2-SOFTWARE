// Decoding diagnostic responses: DTCs (OBD modes 03/07/0A, UDS 0x19),
// VIN (OBD 09 02), negative response codes in plain words.

export const bytesOf = (hex: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16));
  return out;
};

export const toHex = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/** SAE J2012 two-byte DTC to text, e.g. 0x01 0x71 -> P0171, 0x51 0x45 -> C1145. */
export function dtcText(hi: number, lo: number): string {
  const system = "PCBU"[(hi >> 6) & 0x03];
  const d1 = (hi >> 4) & 0x03;
  const rest = (((hi & 0x0f) << 8) | lo).toString(16).toUpperCase().padStart(3, "0");
  return `${system}${d1}${rest}`;
}

export type DtcStatus = "confirmed" | "pending" | "permanent" | "stored" | "history";

export interface ReadDtc {
  code: string;
  status: DtcStatus;
  /** UDS status byte (ISO 14229-1 DTCStatusMask), when read over UDS. */
  statusByte: number | null;
  /** Failure type byte (UDS 3-byte DTC). */
  ftb: number | null;
}

/**
 * OBD modes 03/07/0A. On CAN the reply carries a count byte first
 * (43 NN hi lo ...); on K-line/J1850 it doesn't (43 hi lo ...). Zero pairs
 * (0000) are padding.
 */
export function parseObdDtcs(mode: 0x03 | 0x07 | 0x0a, responseHex: string): ReadDtc[] {
  const b = bytesOf(responseHex);
  if (b[0] !== mode + 0x40) return [];
  let body = b.slice(1);
  if (body.length % 2 === 1 && body[0] === (body.length - 1) / 2) body = body.slice(1);
  const status: DtcStatus = mode === 0x03 ? "confirmed" : mode === 0x07 ? "pending" : "permanent";
  const out: ReadDtc[] = [];
  for (let i = 0; i + 1 < body.length; i += 2) {
    if (body[i] === 0 && body[i + 1] === 0) continue;
    out.push({ code: dtcText(body[i], body[i + 1]), status, statusByte: null, ftb: null });
  }
  return out;
}

export const UDS_STATUS_BITS: [number, string][] = [
  [0x01, "test failed"],
  [0x02, "failed this cycle"],
  [0x04, "pending"],
  [0x08, "confirmed"],
  [0x10, "not completed since clear"],
  [0x20, "failed since clear"],
  [0x40, "not completed this cycle"],
  [0x80, "warning lamp requested"],
];

export function udsStatusWords(statusByte: number): string[] {
  return UDS_STATUS_BITS.filter(([bit]) => statusByte & bit).map(([, word]) => word);
}

/** UDS 59 02 <availability> [hi lo ftb status]... */
export function parseUdsDtcs(responseHex: string): ReadDtc[] {
  const b = bytesOf(responseHex);
  if (b[0] !== 0x59 || (b[1] !== 0x02 && b[1] !== 0x0a)) return [];
  const out: ReadDtc[] = [];
  for (let i = 3; i + 3 < b.length; i += 4) {
    const [hi, lo, ftb, st] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
    if (hi === 0 && lo === 0 && ftb === 0) continue;
    const status: DtcStatus = st & 0x08 ? "confirmed" : st & 0x04 ? "pending" : "history";
    out.push({ code: dtcText(hi, lo), status, statusByte: st, ftb });
  }
  return out;
}

/** OBD 49 02 01 <17 ASCII bytes>; tolerant of the count byte being absent. */
export function parseVin(responseHex: string): string | null {
  const b = bytesOf(responseHex);
  if (b[0] !== 0x49 || b[1] !== 0x02) return null;
  const ascii = String.fromCharCode(...b.slice(2).filter((c) => c >= 0x30 && c <= 0x5a));
  const vin = ascii.slice(-17);
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null;
}

/** Plain-English negative response codes (ISO 14229-1 Annex A). */
const NRC_TEXT: Record<number, string> = {
  0x10: "The module rejected the request (general reject).",
  0x11: "This module doesn't support that service.",
  0x12: "This module doesn't support that function.",
  0x13: "The request had the wrong length or format.",
  0x14: "The response would be too long for the module to send.",
  0x21: "The module is busy. Wait a moment and retry.",
  0x22: "Conditions aren't right for this (check engine state, gear, temperature).",
  0x24: "Steps were done out of order.",
  0x31: "The module doesn't recognise that identifier on this vehicle.",
  0x33: "The module needs security access first.",
  0x35: "Security key was wrong.",
  0x36: "Too many failed attempts; the module has locked access.",
  0x37: "The module needs a delay before another attempt.",
  0x72: "The module failed to program or write.",
  0x78: "The module is still working on it.",
  0x7e: "That function isn't available in the current diagnostic session.",
  0x7f: "That service isn't available in the current diagnostic session.",
  0x81: "Engine speed is too high.",
  0x82: "Engine speed is too low.",
  0x83: "The engine is running; switch it off first.",
  0x84: "The engine must be running for this.",
  0x88: "The vehicle is moving; stop the vehicle first.",
  0x8d: "The module wants the transmission in Park or Neutral.",
  0x92: "Voltage is too high.",
  0x93: "Voltage is too low; connect a battery charger.",
};

export function nrcText(code: number, name?: string): string {
  return NRC_TEXT[code] ?? `The module refused the request${name ? ` (${name})` : ""}.`;
}

export const hexId = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(3, "0")}`;

/** A CAN identifier as shown in CAN Studio: 3 hex digits for 11-bit, 8 for 29-bit extended (A-DES-7). */
export const canIdText = (id: number, extended: boolean): string =>
  extended ? `0x${(id >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : hexId(id);

/** Parses "0x7E0" from the vehicle registry; null when not a CAN id. */
export function parseRegistryId(text: string): number | null {
  const m = /^0x([0-9a-f]+)$/i.exec(text.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return n >= 0x100 && n <= 0x7ff ? n : null;
}
