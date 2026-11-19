// Runtime helpers around the generated wire types (Task 0.2).
//
// `@/types/edge-protocol` and `@/types/safety-policy-schema` are generated from
// packages/schemas by `just codegen` (A-DX-3); this module adds the shared safety
// policy (Rule 3), error hints (A-DX-4) and version compatibility (A-ENG-3),
// mirroring apps/edge-daemon/src/protocol/mod.rs.

import policyJson from "@obd2/schemas/safety_policy.json";
import hintsJson from "@obd2/schemas/error_hints.json";
import {
  EdgeMessage,
  type DiagProtocol,
  type ErrorCode,
  PROTOCOL_VERSION,
} from "@/types/edge-protocol";
import { SafetyPolicy, type GatedService } from "@/types/safety-policy-schema";

export { PROTOCOL_VERSION };

/** Rule 3: the only list of gated services, the same file the daemon embeds. */
export const SAFETY_POLICY: SafetyPolicy = SafetyPolicy.parse(policyJson);
export const POLICY_VERSION = SAFETY_POLICY.policy_version;

const HINTS: Record<string, string> = hintsJson;

export type ParseResult =
  | { ok: true; message: EdgeMessage }
  | { ok: false; error: string };

/** Parses one WebSocket text frame from the daemon (or a test client). */
export function parseMessage(text: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `invalid JSON message: ${(e as Error).message}` };
  }
  const result = EdgeMessage.safeParse(value);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: `message breaks the schema: ${result.error.message}` };
}

/** Validates and serializes a message for the wire; throws on an invalid message. */
export function toWire(message: EdgeMessage): string {
  return JSON.stringify(EdgeMessage.parse(message));
}

const hexByte = (text: string) => Number.parseInt(text.slice(2), 16);

/** The gated rule covering a request, if any. A rule with no sub-function covers all of them. */
export function gatedRule(
  protocol: DiagProtocol,
  serviceId: number,
  subFunction: number | null,
): GatedService | undefined {
  return SAFETY_POLICY.gated.find(
    (rule) =>
      rule.protocol === protocol &&
      hexByte(rule.service_id) === serviceId &&
      (rule.sub_function === null || hexByte(rule.sub_function) === subFunction),
  );
}

/** Canonical gated set, e.g. "UDS 0x10/0x02 B"; identical to the daemon's gated_set_canonical(). */
export function gatedSetCanonical(): string[] {
  return SAFETY_POLICY.gated
    .map((rule) => `${rule.protocol} ${rule.service_id}/${rule.sub_function ?? "*"} ${rule.tier}`)
    .sort();
}

/** One-line fix-it text for an error code (A-DX-4). */
export function errorHint(code: ErrorCode): string {
  return HINTS[code] ?? "Check the edge daemon log for details.";
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether two protocol or policy versions can talk (A-ENG-3): same major, and for 0.x
 * also the same minor. Symmetric, matching the daemon's versions_compatible().
 */
export function versionsCompatible(ours: string, theirs: string): boolean {
  const a = parseSemver(ours);
  const b = parseSemver(theirs);
  if (!a || !b) return false;
  return a[0] === b[0] && (a[0] !== 0 || a[1] === b[1]);
}
