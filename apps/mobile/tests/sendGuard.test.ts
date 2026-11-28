import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCommand } from "../src/obd/sendGuard";

const gatedFixture = readFileSync(
  join(__dirname, "../../../packages/schemas/fixtures/gated_set.txt"),
  "utf8",
)
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

describe("send guard (allow-list, D2)", () => {
  it.each(["ATZ", "ATE0", "ATL0", "ATS0", "ATH1", "ATSP0", "ATDPN", "ATRV", "ATAT1", "ATI", "STI"])(
    "allows setup command %s",
    (cmd) => expect(checkCommand(cmd).ok).toBe(true),
  );

  it.each(["0100", "010C0D05", "010C0D05041110", "0101", "020200", "020C00", "03", "07", "0A", "0902", "0900", "090A", "01 0c"])(
    "allows read %s",
    (cmd) => expect(checkCommand(cmd).ok).toBe(true),
  );

  it("refuses every gated service in safety_policy.json (fixtures/gated_set.txt)", () => {
    expect(gatedFixture.length).toBeGreaterThan(30);
    for (const line of gatedFixture) {
      const [, svc, sub] = line.match(/^\S+ 0x([0-9A-F]{2})\/(\*|0x[0-9A-F]{2})/i)!;
      const cmd = sub === "*" ? `${svc}00` : `${svc}${sub.slice(2)}`;
      expect(checkCommand(cmd)).toMatchObject({ ok: false });
      expect(checkCommand(svc)).toMatchObject({ ok: false });
    }
  });

  it("refuses OBD clear codes (mode 04) and on-board control (mode 08)", () => {
    expect(checkCommand("04")).toMatchObject({ ok: false, reason: expect.stringContaining("desktop app") });
    expect(checkCommand("0801")).toMatchObject({ ok: false });
  });

  it.each(["STPX H:7E0, D:0401", "STPX", "ATSH7E0", "ATMA", "ATBI", "ATCRA7E8", "ATPP0CSV01", "ATWS", "STSBR 115200", "ATD", "ATSP6"])(
    "refuses dongle command %s that could send raw frames or change setup",
    (cmd) => expect(checkCommand(cmd).ok).toBe(false),
  );

  it.each(["", "zz", "0", "01", "0101020304050607", "0203", "0300", "0901", "1902FF", "2201F190", "3E00"])(
    "refuses unknown or malformed request %p",
    (cmd) => expect(checkCommand(cmd).ok).toBe(false),
  );
});
