// Task 0.2 verification gate, TypeScript side. Mirrors
// apps/edge-daemon/tests/protocol_parity.rs over the same shared fixtures.
// Run with UPDATE_FIXTURES=1 to rewrite fixtures/ts/ after a schema change.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import edgeSchema from "@obd2/schemas/edge_ws.schema.json";
import hints from "@obd2/schemas/error_hints.json";
import { EdgeMessage, MESSAGE_TYPES, REQUEST_RESPONSE } from "../../src/types/edge-protocol";
import {
  errorHint,
  gatedRule,
  gatedSetCanonical,
  parseMessage,
  toWire,
  versionsCompatible,
} from "../../src/lib/edge-protocol";
import { tsFixtures } from "./ts-fixtures";

const fixtures = join(__dirname, "../../../../packages/schemas/fixtures");
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

// The raw schema, independent of the generated Zod code. Unknown `format`
// values (uint8 etc. are typify hints) are ignored, as in the Rust validator.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validateRaw = ajv.compile(edgeSchema);

/** Same key order as serde_json's sorted map, so files are stable. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}
const pretty = (value: unknown) => JSON.stringify(sortKeys(value), null, 2) + "\n";

describe("TS fixtures", () => {
  it("cover every message type, validate, and match the checked-in files", () => {
    expect(Object.keys(tsFixtures).sort()).toEqual([...MESSAGE_TYPES].sort());
    for (const [name, message] of Object.entries(tsFixtures)) {
      const wire = toWire(message);
      expect(parseMessage(wire)).toMatchObject({ ok: true });
      expect(validateRaw(message), `${name}: ${ajv.errorsText(validateRaw.errors)}`).toBe(true);
      const path = join(fixtures, "ts", `${name}.json`);
      if (process.env.UPDATE_FIXTURES) writeFileSync(path, pretty(message));
      expect(readFileSync(path, "utf8"), `${path} is stale; run with UPDATE_FIXTURES=1`).toBe(
        pretty(message),
      );
    }
  });
});

describe("Rust fixtures", () => {
  it("cover every message type and parse with Zod and the raw schema", () => {
    const dir = join(fixtures, "rust");
    const seen = new Set<string>();
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      const result = parseMessage(text);
      expect(result, `${file} rejected by Zod`).toMatchObject({ ok: true });
      if (!result.ok) continue;
      expect(validateRaw(JSON.parse(text)), file).toBe(true);
      // Zod must not drop or rewrite anything Rust sent.
      expect(sortKeys(result.message)).toEqual(sortKeys(JSON.parse(text)));
      seen.add(result.message.type);
    }
    expect([...seen].sort()).toEqual([...MESSAGE_TYPES].sort());
  });
});

describe("invalid messages", () => {
  const cases = readJson(join(fixtures, "invalid.json")) as { why: string; message: unknown }[];
  it.each(cases)("rejects: $why", ({ message }) => {
    expect(EdgeMessage.safeParse(message).success).toBe(false);
    expect(validateRaw(message)).toBe(false);
  });
});

describe("requests and responses", () => {
  it("every request has a response type that echoes request_id; any request can fail", () => {
    const requests = MESSAGE_TYPES.filter((t) => t.endsWith("Request")).sort();
    expect(Object.keys(REQUEST_RESPONSE).sort()).toEqual(requests);
    for (const response of Object.values(REQUEST_RESPONSE)) {
      expect(MESSAGE_TYPES).toContain(response);
      expect(Object.keys(tsFixtures[response])).toContain("request_id");
    }
    expect(Object.keys(tsFixtures.ErrorResponse)).toContain("request_id");
  });
});

describe("safety policy (Rule 3)", () => {
  it("matches the gated set the daemon sees", () => {
    const golden = readFileSync(join(fixtures, "gated_set.txt"), "utf8");
    expect(gatedSetCanonical().join("\n") + "\n").toBe(golden);
  });

  it("matches sub-functions like the daemon", () => {
    expect(gatedRule("UDS", 0x10, 0x02)?.tier).toBe("B");
    expect(gatedRule("UDS", 0x10, 0x03)).toBeUndefined();
    expect(gatedRule("UDS", 0x31, 0x01)).toBeDefined();
    expect(gatedRule("UDS", 0x22, null)).toBeUndefined();
    expect(gatedRule("OBD", 0x04, null)).toBeDefined();
  });
});

describe("error hints (A-DX-4)", () => {
  it("every code has exactly one single-line hint", () => {
    const codes = edgeSchema.definitions.ErrorCode.enum;
    expect(Object.keys(hints).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const hint = errorHint(code as Parameters<typeof errorHint>[0]);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.length).toBeLessThanOrEqual(200);
      expect(hint).not.toMatch(/[\r\n]/);
    }
  });
});

describe("version compatibility (A-ENG-3)", () => {
  const cases = readJson(join(fixtures, "version_compat.json")) as {
    ours: string;
    theirs: string;
    compatible: boolean;
  }[];
  it.each(cases)("$ours vs $theirs -> $compatible, both ways", ({ ours, theirs, compatible }) => {
    expect(versionsCompatible(ours, theirs)).toBe(compatible);
    expect(versionsCompatible(theirs, ours)).toBe(compatible);
  });
});
