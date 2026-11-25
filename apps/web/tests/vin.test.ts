import { describe, expect, it } from "vitest";
import { normalizeBus, redactVin } from "@/lib/vin";

describe("redactVin", () => {
  it("keeps WMI+VDS and masks the serial of a 17-character VIN", () => {
    expect(redactVin("MPBUMFF60PX418290")).toBe("MPBUMFF60••••••••");
  });

  it("is a no-op on an already short empty value", () => {
    expect(redactVin("")).toBe("");
    expect(redactVin("  abcd  ")).toBe("••••");
  });
});

describe("normalizeBus", () => {
  it("maps registry labels onto topology groups", () => {
    expect(normalizeBus("HS-CAN 500k")).toBe("HS-CAN");
    expect(normalizeBus("GMLAN HS-CAN 500k")).toBe("HS-CAN");
    expect(normalizeBus("PT-CAN / D-CAN")).toBe("HS-CAN");
    expect(normalizeBus("MS-CAN 125k (STP 53)")).toBe("MS-CAN");
    expect(normalizeBus("K-CAN / D-CAN")).toBe("OTHER");
    expect(normalizeBus("OBD-II Functional")).toBe("OTHER");
  });
});
