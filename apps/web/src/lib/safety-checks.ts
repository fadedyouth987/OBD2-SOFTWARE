import { SAFETY_POLICY } from "@/lib/edge-protocol";

export interface LiveReadings {
  speedKmh: number | null;
  rpm: number | null;
  batteryV: number | null;
  /** How long ago each reading arrived; null when unknown (no timestamp). */
  speedAgeMs?: number | null;
  rpmAgeMs?: number | null;
  batteryAgeMs?: number | null;
}

/** Battery voltage changes slowly; a reading this old is still usable. */
const BATTERY_MAX_AGE_MS = 10_000;


/** `reading` names the signal itself ("road speed"), for sentences about a missing reading. */
export type Check = { label: string; reading: string; state: "ok" | "fail" | "unknown"; value: string };

/**
 * One precondition. Like the daemon (Rule 5), it fails closed: a missing
 * reading, or one older than the policy allows, counts as unknown and blocks.
 */
function check(
  label: string,
  reading: string,
  value: number | null,
  ageMs: number | null | undefined,
  maxAgeMs: number,
  pass: (v: number) => boolean,
  show: (v: number) => string,
): Check {
  if (value === null) return { label, reading, state: "unknown", value: "no reading" };
  if (ageMs != null && ageMs > maxAgeMs) {
    return { label, reading, state: "unknown", value: `stale (${Math.round(ageMs / 1000)} s old)` };
  }
  return { label, reading, state: pass(value) ? "ok" : "fail", value: show(value) };
}

export function liveChecks(tier: "A" | "B", live: LiveReadings): Check[] {
  const req = SAFETY_POLICY.tiers[tier];
  const maxAge = req.max_speed_age_ms;
  const checks: Check[] = [
    check(`Vehicle stationary (${req.max_speed_kmh} km/h)`, "road speed", live.speedKmh, live.speedAgeMs, maxAge,
      (v) => v <= req.max_speed_kmh, (v) => `${v.toFixed(0)} km/h`),
  ];
  if (req.max_rpm !== null) {
    const maxRpm = req.max_rpm;
    checks.push(check("Engine off (0 rpm)", "engine speed", live.rpm, live.rpmAgeMs, maxAge, (v) => v <= maxRpm, (v) => `${v.toFixed(0)} rpm`));
  }
  if (req.min_battery_v !== null) {
    const minV = req.min_battery_v;
    checks.push(check(`Battery at least ${minV} V`, "battery voltage", live.batteryV, live.batteryAgeMs, BATTERY_MAX_AGE_MS,
      (v) => v >= minV, (v) => `${v.toFixed(1)} V`));
  }
  return checks;
}

