// Release 1 is read-only. Every command the app sends to a dongle passes through
// checkCommand() first; anything not on the allow-list is refused before it reaches
// Bluetooth (docs/design/mobile-app.md, decision D2).
//
// Layer 1, the allow-list: the AT/ST setup commands the driver uses, and OBD-II read
// requests (modes 01, 02, 03, 07, 09, 0A) in their exact shapes.
// Layer 2, packages/schemas/safety_policy.json: a request whose service byte is on
// the gated list (any protocol) is refused even if layer 1 were ever widened by
// mistake. That file is the only list of gated services (PLAN.md Rule 3).

import policy from "@obd2/schemas/safety_policy.json";

export type GuardResult = { ok: true } | { ok: false; reason: string };

// ELM327 / STN setup commands the driver may send. Everything else (including
// raw-transmit commands such as STPX, header changes such as ATSH, and monitor
// modes) is refused.
const AT_ALLOWED = /^(AT(Z|E0|L0|S0|H1|SP0|DPN|RV|I|@1|AT[0-2]|ST[0-9A-F]{2}|CAF1)|STI)$/;

const GATED_SERVICE_BYTES: ReadonlySet<number> = new Set(
  policy.gated.map((g) => Number.parseInt(g.service_id, 16)),
);

/** Exact shapes of the OBD-II read requests the app makes, as hex without spaces. */
function obdShapeOk(hex: string): boolean {
  const mode = hex.slice(0, 2);
  const rest = hex.slice(2);
  switch (mode) {
    case "01": // live data: 1 to 6 PIDs
      return rest.length >= 2 && rest.length <= 12 && rest.length % 2 === 0;
    case "02": // freeze frame: PID + frame number
      return rest.length === 4;
    case "03": // stored codes
    case "07": // pending codes
    case "0A": // permanent codes
      return rest.length === 0;
    case "09": // vehicle info: supported list, VIN, ECU name
      return rest === "00" || rest === "02" || rest === "0A";
    default:
      return false;
  }
}

export function checkCommand(raw: string): GuardResult {
  const cmd = raw.replace(/\s+/g, "").toUpperCase();
  if (cmd.length === 0) return { ok: false, reason: "Empty command." };
  if (cmd.startsWith("AT") || cmd.startsWith("ST")) {
    return AT_ALLOWED.test(cmd)
      ? { ok: true }
      : { ok: false, reason: `Dongle command ${cmd} isn't allowed in the read-only app.` };
  }
  if (!/^([0-9A-F]{2})+$/.test(cmd)) return { ok: false, reason: "Not a valid request." };
  const service = Number.parseInt(cmd.slice(0, 2), 16);
  if (GATED_SERVICE_BYTES.has(service)) {
    return { ok: false, reason: "That request changes the vehicle. Use the desktop app, which runs the safety checks first." };
  }
  if (!obdShapeOk(cmd)) {
    return { ok: false, reason: `Request ${cmd} isn't a read the app allows.` };
  }
  return { ok: true };
}
