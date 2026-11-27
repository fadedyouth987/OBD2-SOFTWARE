import { Api, ApiError } from "../src/api/client";
import type { CodeScan } from "../src/obd/scan";
import { reportHtml } from "../src/report";

jest.mock("react-native-ble-plx", () => ({ BleManager: class {} }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { fromBase64, toBase64 } = require("../src/transports/ble") as typeof import("../src/transports/ble");

const complete: CodeScan = {
  status: "complete",
  stored: { status: "ok", value: [{ ecu: "7E8", module: "Engine", codes: [{ code: "P0171", status: "confirmed", statusByte: null, ftb: null }] }] },
  pending: { status: "ok", value: [] },
  permanent: { status: "not supported" },
};

describe("customer report", () => {
  it("masks the VIN and lists codes with their meaning", () => {
    const html = reportHtml({ scan: complete, vin: { status: "ok", value: "6FPAAAJGCM4A12345" }, readiness: null, diagnosis: null, server: null });
    expect(html).not.toContain("6FPAAAJGCM4A12345");
    expect(html).toContain("P0171");
    expect(html).toContain("Engine");
  });

  it("says the scan was incomplete instead of 'no codes'", () => {
    const html = reportHtml({ scan: { ...complete, status: "incomplete", stored: { status: "failed", reason: "x" } }, vin: null, readiness: null, diagnosis: null, server: null });
    expect(html).toContain("Scan incomplete");
    expect(html).not.toContain("No stored fault codes");
  });

  it("escapes text from the server", () => {
    const html = reportHtml({ scan: complete, vin: null, readiness: null, diagnosis: { summary: "<script>alert(1)</script>" }, server: null });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("BLE base64", () => {
  it.each(["", "A", "AT", "ATZ\r", "0100\r", "7E8 06 41 00 BE 3F A8 13\r\r>"])("round-trips %p", (s) => {
    expect(fromBase64(toBase64(s))).toBe(s);
  });
  it("matches standard base64", () => {
    expect(toBase64("ATZ\r")).toBe("QVRaDQ==");
    expect(fromBase64("QVRaDQ==")).toBe("ATZ\r");
  });
});

describe("API client", () => {
  const respond = (status: number, body: unknown) =>
    jest.fn(async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response);

  it("sends the token and returns JSON", async () => {
    const f = respond(200, { entitlements: { tier: "MOBILE" } });
    const api = new Api("https://api.test/", "tok", f as unknown as typeof fetch);
    await expect(api.me()).resolves.toMatchObject({ entitlements: { tier: "MOBILE" } });
    expect(f).toHaveBeenCalledWith("https://api.test/api/v1/auth/me", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) }));
  });

  it("turns errors into plain messages", async () => {
    await expect(new Api("https://x", "t", respond(401, {}) as unknown as typeof fetch).me()).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/expired/) });
    await expect(new Api("https://x", "t", respond(400, { detail: "Bad VIN" }) as unknown as typeof fetch).me()).rejects.toMatchObject({ message: "Bad VIN" });
    const offline = jest.fn(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(new Api("https://x", "t", offline as unknown as typeof fetch).me()).rejects.toBeInstanceOf(ApiError);
  });

  it("sends codes per module when saving a job", async () => {
    const f = respond(200, { id: "j1" });
    await new Api("https://x", "t", f as unknown as typeof fetch).saveCodes("j1", [{ module: "Engine", codes: complete.stored.status === "ok" ? complete.stored.value[0].codes : [] }]);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual({ dtcs: [{ code: "P0171", module: "Engine", status: "confirmed", source: "OBD" }] });
  });
});
