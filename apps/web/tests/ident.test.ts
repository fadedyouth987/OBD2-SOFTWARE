import { describe, expect, it } from "vitest";
import { identText, readIdent } from "@/lib/ident";
import { EdgeRequestError } from "@/lib/edge-client";
import type { DiagFn } from "@/lib/scan";
import { redactVin } from "@/lib/vin";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
const reply = (positive: boolean, hex: string) => ({ type: "DiagCommandResponse" as const, request_id: "r", positive, response_hex: hex, nrc: positive ? null : { code: 0x31, name: "requestOutOfRange" } });

describe("identText", () => {
  it("shows text as text and binary as hex", () => {
    expect(identText([0x41, 0x42, 0x00])).toBe("AB");
    expect(identText([0x01, 0xa0])).toBe("01 A0");
  });
});

describe("readIdent", () => {
  it("reads UDS DIDs, skips unsupported ones and redacts the VIN", async () => {
    const diag: DiagFn = async ({ payloadHex }) => {
      if (payloadHex === "22F190") return reply(true, `62F190${ascii("SBXTESTVAN0000001")}`);
      if (payloadHex === "22F187") return reply(true, `62F187${ascii("GEN-ECU-0001")}`);
      return reply(false, `7F2231`);
    };
    const r = await readIdent(diag, { module: "ENGINE", tx: 0x7e0, rx: 0x7e8, protocol: "UDS", obd: true });
    expect(r.fields).toEqual([
      // Same rule as the job header and the cloud anonymizer: positions 10-17 hidden.
      { label: "VIN", value: redactVin("SBXTESTVAN0000001") },
      { label: "Part number", value: "GEN-ECU-0001" },
    ]);
    expect(r.missing).toEqual(["Serial number", "Hardware number", "Software version"]);
    expect(redactVin("SBXTESTVAN0000001")).toBe("SBXTESTVA••••••••");
  });
  it("reads KWP identification", async () => {
    const r = await readIdent(async ({ payloadHex }) => (payloadHex === "1A80" ? reply(true, `5A80${ascii("6943835 CAS3")}`) : reply(false, "7F1A31")), {
      module: "CAS",
      tx: 0x6f1,
      rx: 0x640,
      protocol: "KWP2000",
      obd: false,
    });
    expect(r.fields).toEqual([{ label: "ECU identification", value: "6943835 CAS3" }]);
  });
  it("gives up quickly on a silent module", async () => {
    let calls = 0;
    const r = await readIdent(async () => {
      calls += 1;
      throw new EdgeRequestError("TIMEOUT", "no reply", "");
    }, { module: "X", tx: 0x700, rx: 0x708, protocol: "UDS", obd: false });
    expect(calls).toBe(1);
    expect(r.fields).toEqual([]);
    expect(r.message).toBe("No response.");
  });
});
