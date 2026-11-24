/** Display-safe VIN redaction: keep WMI+VDS (characters 1-9), mask the rest. */
export function redactVin(vin: string): string {
  const cleaned = vin.trim().toUpperCase();
  if (!cleaned) return "";
  if (cleaned.length <= 4) return "•".repeat(cleaned.length);
  if (cleaned.length < 17) {
    return `${cleaned.slice(0, 3)}${"•".repeat(Math.max(0, cleaned.length - 3))}`;
  }
  return `${cleaned.slice(0, 9)}${"•".repeat(cleaned.length - 9)}`;
}

export type TopologyBus = "HS-CAN" | "MS-CAN" | "OTHER";

/** Map registry strings such as "HS-CAN 500k" or "PT-CAN / D-CAN" onto viewer groups. */
export function normalizeBus(raw: string): TopologyBus {
  const s = raw.toUpperCase();
  if (s.includes("MS-CAN") || s.includes("MSCAN")) {
    return "MS-CAN";
  }
  if (
    s.includes("HS-CAN") ||
    s.includes("HSCAN") ||
    s.includes("PT-CAN") ||
    s.includes("GMLAN")
  ) {
    return "HS-CAN";
  }
  return "OTHER";
}
