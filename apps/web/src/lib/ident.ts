// Module identification: UDS 0x22 identification DIDs (ISO 14229 F18x/F19x)
// or KWP2000 0x1A ReadECUIdentification. Read-only, never gated.

import { bytesOf } from "@/lib/diag";
import { EdgeRequestError } from "@/lib/edge-client";
import { redactVin } from "@/lib/vin";
import type { DiagFn, ScanTarget } from "@/lib/scan";

export interface IdentField {
  label: string;
  value: string;
}

export interface IdentResult {
  fields: IdentField[];
  /** Why nothing was read, when fields is empty. */
  message: string;
  /** Identifiers the module was asked for but didn't report. */
  missing?: string[];
}

export const UDS_IDENT_DIDS: [number, string][] = [
  [0xf190, "VIN"],
  [0xf187, "Part number"],
  [0xf18c, "Serial number"],
  [0xf191, "Hardware number"],
  [0xf195, "Software version"],
];

export const KWP_IDENT: [number, string][] = [
  [0x80, "ECU identification"],
  [0x90, "VIN"],
];

/** Printable ASCII when the bytes are text, otherwise spaced hex. */
export function identText(bytes: number[]): string {
  const trimmed = bytes.filter((b, i) => !(b === 0 && i === bytes.length - 1) && b !== 0xff);
  const printable = trimmed.length > 0 && trimmed.every((b) => b >= 0x20 && b < 0x7f);
  if (printable) return String.fromCharCode(...trimmed).trim();
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");
}


export async function readIdent(diag: DiagFn, t: ScanTarget): Promise<IdentResult> {
  const fields: IdentField[] = [];
  let lastProblem = "";
  let answered = false;
  const list = t.protocol === "KWP2000" ? KWP_IDENT : t.protocol === "UDS" ? UDS_IDENT_DIDS : [];
  if (!list.length) return { fields, message: "OBD-only address: identification isn't available here." };
  for (const [id, label] of list) {
    const payloadHex =
      t.protocol === "KWP2000"
        ? `1A${id.toString(16).padStart(2, "0")}`
        : `22${id.toString(16).padStart(4, "0")}`;
    try {
      const r = await diag({ tx: t.tx, rx: t.rx, protocol: t.protocol!, payloadHex: payloadHex.toUpperCase() });
      answered = true;
      if (!r.positive) {
        lastProblem = "The module refused the identification request.";
        continue;
      }
      const b = bytesOf(r.response_hex);
      // Positive reply echoes the identifier: 62 DID_hi DID_lo data… / 5A id data…
      const data = t.protocol === "KWP2000" ? b.slice(2) : b.slice(3);
      if (!data.length) continue;
      const text = identText(data);
      fields.push({ label, value: label === "VIN" ? redactVin(text) : text });
    } catch (e) {
      if (e instanceof EdgeRequestError && (e.code === "TIMEOUT" || e.code === "CLIENT_TIMEOUT")) {
        lastProblem = "No response.";
        if (!answered) break; // Don't wait out every identifier on a silent module.
      } else {
        lastProblem = e instanceof Error ? e.message : String(e);
        break;
      }
    }
  }
  const got = new Set(fields.map((f) => f.label));
  return {
    fields,
    message: fields.length ? "" : lastProblem || "The module doesn't report identification.",
    missing: fields.length ? list.map(([, l]) => l).filter((l) => !got.has(l)) : [],
  };
}
