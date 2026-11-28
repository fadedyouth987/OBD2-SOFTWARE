# packages/schemas

Single source of truth for wire contracts (eng review decision d3, A-DX-3). Edit files here, then run `just codegen`.

| File | What | Consumers |
| --- | --- | --- |
| `edge_ws.schema.json` | Every message on the local edge WebSocket (tagged union on `type`), plus `x-protocol-version` and `x-request-response` | Generated Rust types, Zod validators, [`docs/protocol.md`](../../docs/protocol.md) |
| `safety_policy.json` | The only list of gated diagnostic services and their tier preconditions (Rule 3) | Rust `include_str!`, web app import |
| `safety_policy.schema.json` | Shape of `safety_policy.json` | Generated Rust/Zod types; validated on load |
| `module_catalog.json` | Module names and diagnostic addresses per make family, the address ranges the scanner sweeps to find unlisted modules, and the source for every entry | Web module discovery (`apps/web/src/lib/module-catalog.ts`), cloud-api registry tests |
| `module_catalog.schema.json` | Shape of `module_catalog.json` | Validated in web and cloud-api tests |
| `error_hints.json` | One-line fix-it text for every `ErrorCode` (A-DX-4) | Rust and web `errorHint` |
| `fixtures/` | Shared parity fixtures (see below) | Rust and TS tests |

## Generated files (do not edit)

| Output | Generator |
| --- | --- |
| `apps/edge-daemon/src/protocol/messages.rs`, `policy_types.rs` | `tools/codegen` (typify) |
| `apps/web/src/types/edge-protocol.ts`, `safety-policy-schema.ts` | `scripts/codegen.mjs` (json-schema-to-zod) |
| `docs/protocol.md` | `scripts/codegen.mjs` |

`just lint` runs `just codegen-check`, which fails if any of these is stale.

Schema conventions, so both generators produce strict, matching code:

- Draft-07 with `definitions`; every object has `additionalProperties: false` and lists all fields in `required`. Optional values are required-but-nullable (`"type": ["string", "null"]`), never omitted.
- Message tags are single-value enums (`"type": { "enum": ["HelloRequest"] }`), which typify enforces; `const` is not.
- Integers carry a `format` hint (`uint8`, `uint16`, `uint32`, `uint64`) so typify picks the right Rust width. Validators ignore it.
- typify does not check numeric ranges, so the daemon validates every incoming message against this schema (`protocol::parse_message`) before serde. Rust and Zod enforce the same rules.

## Parity fixtures (Task 0.2 gate)

- `fixtures/rust/`: one message of each type built through the Rust types; Zod and the raw schema (ajv) must accept them unchanged.
- `fixtures/ts/`: one of each built through the Zod types; Rust must accept and round-trip them.
- `fixtures/invalid.json`: messages both sides must reject.
- `fixtures/gated_set.txt`: canonical gated set; both languages must produce exactly this from `safety_policy.json`.
- `fixtures/version_compat.json`: protocol/policy version compatibility, checked in both directions (A-ENG-3).

After a schema change: `just codegen`, then `UPDATE_FIXTURES=1 cargo test -p edge-daemon --test protocol_parity` and `cd apps/web && UPDATE_FIXTURES=1 pnpm test`, and review the fixture diff.
