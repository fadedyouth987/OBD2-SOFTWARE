import { busForProtocol, FrameError, parseReplyLines } from "../src/obd/frames";

describe("parseReplyLines", () => {
  it("splits CAN replies by module and strips the PCI byte", () => {
    const r = parseReplyLines(["7E8 04 43 01 01 71 00 00", "7E9 02 43 00 00 00 00 00"], "can11");
    expect(r).toEqual([
      { ecu: "7E8", payload: [0x43, 0x01, 0x01, 0x71] },
      { ecu: "7E9", payload: [0x43, 0x00] },
    ]);
  });

  it("joins an ISO-TP multi-frame VIN", () => {
    const r = parseReplyLines(
      [
        "7E8 10 14 49 02 01 36 46 50",
        "7E8 21 41 41 41 4A 47 43 4D",
        "7E8 22 34 41 31 32 33 34 35",
      ],
      "can11",
    );
    expect(r[0].payload.length).toBe(0x14);
    expect(String.fromCharCode(...r[0].payload.slice(3))).toBe("6FPAAAJGCM4A12345");
  });

  it("interleaves two modules' multi-frame replies", () => {
    const r = parseReplyLines(
      ["7E8 10 08 43 03 01 71 03 00", "7E9 03 43 01 07", "7E8 21 04 20 00 00 00 00 00"],
      "can11",
    );
    expect(r.find((m) => m.ecu === "7E8")!.payload).toEqual([0x43, 0x03, 0x01, 0x71, 0x03, 0x00, 0x04, 0x20]);
    expect(r.find((m) => m.ecu === "7E9")!.payload).toEqual([0x43, 0x01, 0x07]);
  });

  it("reads 11-bit headers printed without spaces", () => {
    expect(parseReplyLines(["7E8064100BE3FA813"], "can11")[0]).toEqual({
      ecu: "7E8",
      payload: [0x41, 0x00, 0xbe, 0x3f, 0xa8, 0x13],
    });
  });

  it("reads 29-bit headers", () => {
    expect(parseReplyLines(["18 DA F1 10 03 41 0D 32"], "can29")[0]).toEqual({ ecu: "18DAF110", payload: [0x41, 0x0d, 0x32] });
  });

  it("reads K-line frames, drops the checksum, and joins repeated service bytes", () => {
    const r = parseReplyLines(["48 6B 10 43 01 71 03 00 00 00 C4", "48 6B 10 43 04 20 00 00 00 00 A1"], "legacy");
    expect(r).toEqual([{ ecu: "10", payload: [0x43, 0x01, 0x71, 0x03, 0x00, 0, 0, 0x04, 0x20, 0, 0, 0, 0] }]);
  });

  it("refuses a reply cut short or out of order instead of guessing", () => {
    expect(() => parseReplyLines(["7E8 10 14 49 02 01 36 46 50"], "can11")).toThrow(FrameError);
    expect(() => parseReplyLines(["7E8 10 14 49 02 01 36 46 50", "7E8 22 41 41 41 4A 47 43 4D"], "can11")).toThrow(/out of order/);
    expect(() => parseReplyLines(["7E8 21 41 41"], "can11")).toThrow(/without a first frame/);
    expect(() => parseReplyLines(["7E8 06 41 ZZ"], "can11")).toThrow(/Unreadable/);
  });

  it("maps ELM protocol numbers to bus kinds", () => {
    expect(busForProtocol("A6")).toBe("can11");
    expect(busForProtocol("7")).toBe("can29");
    expect(busForProtocol("A3")).toBe("legacy");
  });
});
