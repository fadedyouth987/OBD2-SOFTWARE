import { Elm327, ElmError } from "../src/obd/elm327";
import { DEMO_CAR, Elm327Emulator, type EmulatorOptions } from "../src/obd/emulator";
import { readFreezeFrame, readLive, readReadiness, readSupportedPids, readVin, scanCodes } from "../src/obd/scan";

async function connect(opts: EmulatorOptions = {}) {
  const emu = new Elm327Emulator(DEMO_CAR, opts);
  const elm = new Elm327(emu, 500);
  await elm.init();
  return { emu, elm };
}

describe("Elm327 driver", () => {
  it("initialises: reset, required settings, protocol and voltage", async () => {
    const { elm, emu } = await connect();
    expect(elm.info).toEqual({ version: "ELM327 v1.5", protocol: "A6", bus: "can11", voltage: "12.6V" });
    expect(emu.sent.slice(0, 6)).toEqual(["ATZ", "ATE0", "ATL0", "ATS0", "ATH1", "ATSP0"]);
  });

  it("copes with a clone that keeps echoing and sends replies in small BLE-sized chunks", async () => {
    const { elm } = await connect({ stickyEcho: true, chunkSize: 5 });
    const vin = await readVin(elm);
    expect(vin).toEqual({ status: "ok", value: "6FPAAAJGCM4A12345" });
  });

  it("treats an unknown optional command as fine and a required one as an unsupported dongle", async () => {
    await expect(connect({ unknown: ["ATAT1"] })).resolves.toBeTruthy();
    await expect(connect({ unknown: ["ATH1"] })).rejects.toMatchObject({ kind: "unsupported-dongle" });
  });

  it("never sends a refused command to the dongle", async () => {
    const { elm, emu } = await connect();
    const before = emu.sent.length;
    await expect(elm.send("04")).rejects.toBeInstanceOf(ElmError);
    await expect(elm.send("STPX H:7E0, D:0401")).rejects.toMatchObject({ kind: "refused" });
    expect(emu.sent.length).toBe(before);
  });
});

describe("scanCodes", () => {
  it("reads stored, pending and permanent codes per module", async () => {
    const { elm } = await connect();
    const scan = await scanCodes(elm);
    expect(scan.status).toBe("complete");
    if (scan.stored.status !== "ok") throw new Error("stored not ok");
    expect(scan.stored.value.map((m) => [m.module, m.codes.map((c) => c.code)])).toEqual([
      ["Engine", ["P0171", "P0300"]],
      ["Transmission", ["P0700"]],
    ]);
    expect(scan.pending).toMatchObject({ status: "ok" });
    expect(scan.permanent).toMatchObject({ status: "ok" });
  });

  it("reports a car with no codes as complete with empty lists", async () => {
    const car = { ...DEMO_CAR, codes: { "7E8": { stored: [], pending: [], permanent: [] } } };
    const elm = new Elm327(new Elm327Emulator(car), 500);
    await elm.init();
    const scan = await scanCodes(elm);
    expect(scan.status).toBe("complete");
    expect(scan.stored).toEqual({ status: "ok", value: [{ ecu: "7E8", module: "Engine", codes: [] }] });
  });

  it("marks the scan incomplete, never 'no codes', when Bluetooth drops mid-scan", async () => {
    const { elm } = await connect({ dropAfter: 10 });
    const scan = await scanCodes(elm);
    expect(scan.status).toBe("incomplete");
    expect(scan.stored.status).toBe("failed");
    expect(elm.connected).toBe(false);
  });

  it("marks the scan incomplete when the car doesn't answer mode 03", async () => {
    const { elm } = await connect({ noData: ["03"] });
    const scan = await scanCodes(elm);
    expect(scan.status).toBe("incomplete");
    expect(scan.stored).toEqual({ status: "not supported" });
  });

  it("reports permanent codes as not supported on an older car, without failing the scan", async () => {
    const car = { ...DEMO_CAR, codes: { "7E8": { stored: ["0171"], pending: [], permanent: null } } };
    const elm = new Elm327(new Elm327Emulator(car), 500);
    await elm.init();
    const scan = await scanCodes(elm);
    expect(scan.status).toBe("complete");
    expect(scan.permanent).toEqual({ status: "not supported" });
  });

  it.each(["CAN ERROR", "BUS INIT: ...ERROR", "STOPPED"])("treats %s as a failed read", async (err) => {
    const { elm, emu } = await connect();
    const original = emu.write.bind(emu);
    emu.write = async (text: string) => {
      if (text.startsWith("03")) {
        (emu as unknown as { emit(t: string): void }).emit(`${err}\r\r>`);
        return;
      }
      return original(text);
    };
    const scan = await scanCodes(elm);
    expect(scan.status).toBe("incomplete");
    expect(scan.stored.status).toBe("failed");
  });
});

describe("other reads", () => {
  it("reads readiness monitors", async () => {
    const { elm } = await connect();
    const r = await readReadiness(elm);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.value.milOn).toBe(true);
    expect(r.value.storedCodes).toBe(2);
  });

  it("reads supported PIDs and batches six per request on CAN", async () => {
    const { elm, emu } = await connect();
    const supported = await readSupportedPids(elm);
    if (supported.status !== "ok") throw new Error(supported.status);
    expect(supported.value).toEqual(expect.arrayContaining([0x0c, 0x0d, 0x05, 0x42]));
    const before = emu.sent.length;
    const live = await readLive(elm, [0x0c, 0x0d, 0x05, 0x04, 0x11, 0x0b, 0x0f, 0x10]);
    expect(emu.sent.length - before).toBe(2);
    if (live.status !== "ok") throw new Error(live.status);
    expect(live.value.find((v) => v.pid === 0x0c)?.value).toBe(720);
    expect(live.value.find((v) => v.pid === 0x05)?.value).toBe(83);
  });

  it("reads the freeze frame and the code that stored it", async () => {
    const { elm } = await connect();
    const ff = await readFreezeFrame(elm, [0x0c, 0x05, 0x06]);
    if (ff.status !== "ok") throw new Error(ff.status);
    expect(ff.value.code).toBe("P0171");
    expect(ff.value.values.map((v) => v.pid)).toEqual([0x0c, 0x05, 0x06]);
  });

  it("reports live data as failed (not empty) when the link drops", async () => {
    const { elm } = await connect({ dropAfter: 10 });
    const live = await readLive(elm, [0x0c]);
    expect(live.status).toBe("failed");
  });
});
