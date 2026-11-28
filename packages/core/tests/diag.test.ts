import { describe, expect, it } from "vitest";
import { dtcText, nrcText, parseObdDtcs, parseRegistryId, parseUdsDtcs, parseVin, udsStatusWords } from "../src/diag";
import { describeDtc } from "../src/dtc-library";

describe("dtcText", () => {
  it("decodes SAE J2012 two-byte codes", () => {
    expect(dtcText(0x01, 0x71)).toBe("P0171");
    expect(dtcText(0x51, 0x45)).toBe("C1145");
    expect(dtcText(0xc1, 0x00)).toBe("U0100");
    expect(dtcText(0x9a, 0x2f)).toBe("B1A2F");
  });
});

describe("parseObdDtcs", () => {
  it("handles the CAN count byte", () => {
    expect(parseObdDtcs(0x03, "43010171").map((d) => d.code)).toEqual(["P0171"]);
    expect(parseObdDtcs(0x07, "4702017401 74".replace(" ", "")).map((d) => [d.code, d.status])).toEqual([
      ["P0174", "pending"],
      ["P0174", "pending"],
    ]);
  });
  it("handles K-line replies without a count byte and skips padding", () => {
    expect(parseObdDtcs(0x03, "4301710000").map((d) => d.code)).toEqual(["P0171"]);
  });
  it("returns nothing for no codes, a different mode, or a negative reply", () => {
    expect(parseObdDtcs(0x0a, "4A00")).toEqual([]);
    expect(parseObdDtcs(0x03, "47010171")).toEqual([]);
    expect(parseObdDtcs(0x03, "7F0312")).toEqual([]);
  });
});

describe("parseUdsDtcs", () => {
  it("reads code, failure type and status", () => {
    const list = parseUdsDtcs("5902FF01710009" + "51450004" + "00000000");
    expect(list).toEqual([
      { code: "P0171", status: "confirmed", statusByte: 0x09, ftb: 0x00 },
      { code: "C1145", status: "pending", statusByte: 0x04, ftb: 0x00 },
    ]);
  });
  it("describes status bits", () => {
    expect(udsStatusWords(0x09)).toEqual(["test failed", "confirmed"]);
  });
});

describe("parseVin", () => {
  const vin = "SBXTESTVAN0000001";
  const hex = Array.from(vin, (c) => c.charCodeAt(0).toString(16)).join("");
  it("reads the VIN with or without the count byte", () => {
    expect(parseVin(`490201${hex}`)).toBe(vin);
    expect(parseVin(`4902${hex}`)).toBe(vin);
  });
  it("rejects invalid replies", () => {
    expect(parseVin("7F0912")).toBeNull();
    expect(parseVin("490201414243")).toBeNull();
  });
});

describe("misc", () => {
  it("explains NRCs in plain words and falls back with the name", () => {
    expect(nrcText(0x22)).toMatch(/Conditions/);
    expect(nrcText(0x99, "weird")).toBe("The module refused the request (weird).");
  });
  it("parses registry ids and rejects non-CAN values", () => {
    expect(parseRegistryId("0x7E0")).toBe(0x7e0);
    expect(parseRegistryId("0x12")).toBeNull();
    expect(parseRegistryId("K-line")).toBeNull();
  });
  it("labels manufacturer codes honestly", () => {
    expect(describeDtc("P0171").kind).toBe("generic");
    expect(describeDtc("P1234").kind).not.toBe("generic");
    expect(describeDtc("2A82").kind).not.toBe("generic");
  });
});
