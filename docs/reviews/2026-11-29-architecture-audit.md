# Architecture audit

- **Date:** 2026-11-29
- **Scope:** the whole system: edge daemon (Rust), cloud API (FastAPI), AI worker (Celery), web app (Next.js), Android app (Kotlin), shared schemas, CI and deployment.
- **Baseline:** `main` at `ecb38de`. Open pull requests are noted where they change a finding: #15 (licences, Android sign-in) and #17 (module discovery).
- **Mode:** report only. No code was changed.
- **Method:**
  - Read the code paths end to end.
  - Checked `docs/status.md` and `docs/architecture.md` against the code.
  - Pulled GitHub Actions run history and job logs.
  - Reproduced the CI lint failure locally.

## Verdict

The safety core is well built, and nothing here weakens it on the daemon path. That core is:
- one `SafetyInterlock` that every transport goes through, with fail-closed preconditions;
- single-use, bound safety tokens and a gated-command audit log;
- wire contracts generated from JSON Schema, with parity fixtures;
- row-level security with a non-owner database role;
- offline, Ed25519-signed leases.

Four structural problems matter more than anything else in this report:

1. **CI has been red on `main` since at least 2026-11-27 for a one-line formatting issue.** Because Lint fails first, no tests, web build or end-to-end tests have run on any branch since. The status doc says CI "isn't starting jobs"; it is starting them, and they fail.
2. **The Android app's Bluetooth mode bypasses the safety architecture.** It clears codes straight to the dongle. It uses a hand-copied safety check and writes no audit record. Plan Rules 3 and A-CEO-4 say neither should be possible.
3. **The circuit-topology half of the AI diagnosis isn't connected.** Uploaded schematics are stored but never parsed. The API never queues the ingest job and never talks to Neo4j or Redis. Diagnoses cite the static `shared_nodes` strings from the vehicle registry. The status doc lists Phase 3 as done.
4. **There is no way to deploy the cloud.** There are no container images and no infrastructure-as-code for the API, worker or web app.

## Architecture as built

```
 Workshop PC / tablet                                  Cloud (target: AWS ap-southeast-2)
 ┌──────────────────────────────┐   HTTPS (bearer JWT)  ┌────────────────────────────────────┐
 │ Web app (Next.js, client)    │──────────────────────▶│ cloud-api (FastAPI)                │
 │  session JWT in localStorage │                       │  auth, jobs, billing, accreditation│
 │  edge-client ─ ws://127.0.0.1:8765                   │  diagnose: rules + pgvector cases  │
 └──────────────┬───────────────┘                       │            + Bedrock LLM (sync)    │
 ┌──────────────▼───────────────┐  sync batches         │  one Ed25519 key signs sessions,   │
 │ edge-daemon (Rust)           │──────────────────────▶│  leases, pairing and immo leases   │
 │  SafetyInterlock, audit log  │                       └───────┬───────────────┬────────────┘
 │  ISO-TP / KWP / ELM / J2534  │                               │               │
 └──────────────┬───────────────┘                        Postgres+Timescale   S3 (traces)
                │ CAN / K-line                            +pgvector
             Vehicle                                     ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
 ┌──────────────────────────────┐  Bluetooth SPP         NOT CONNECTED: ai-worker (Celery),
 │ Android app (Kotlin)         │─────────────▶ ELM327   Redis, Neo4j, schematic → graph
 │  own copy of protocol+policy │  (no daemon, no audit)
 └──────────────────────────────┘
```

`docs/architecture.md` still says "Status: Task 0.1 (scaffold)" and shows the target design. Replace it with the as-built picture.

## Findings, most serious first

| # | Severity | Area | Finding | Evidence | Recommendation |
| --- | --- | --- | --- | --- | --- |
| 1 | **High** | CI | **`main` fails Lint, so nothing after it runs.** `services/ai-worker/app/vision/schematic_pipeline.py` fails `ruff format --check`. The quickstart job stops at Lint on `main`, #15 and #17, so tests, migrations, the web build and Playwright never run. The Windows `package` job also fails at "Build MSI (WiX v4)". | Actions runs 46073747760 (`main`), 46154864118 (#17), 46149936832 (#15); `uv run ruff format --check` in `services/ai-worker` | Run `uv run ruff format` on that file. Make `quickstart` a required check on `main`. Fix the MSI build or mark it non-blocking. Correct `docs/status.md`, which says Actions isn't starting jobs. |
| 2 | **High** | Android / safety | **Bluetooth mode bypasses the interlock and the audit log.** The app sends Mode 04 directly over SPP after its own `SafetyPolicyEvaluator`, a hand-written Kotlin copy of the policy. No gated attempt is recorded. The protocol types (`EdgeProtocol.kt`) and the policy are not generated from `packages/schemas`, so they drift silently. #15 adds a licence check but doesn't fix this. | `apps/android/.../data/BluetoothObdClient.kt` `clearDtcs`, `data/SafetyPolicy.kt`; `packages/schemas/scripts/codegen.mjs` has no Kotlin target | **ADR-A below.** Now: make Bluetooth mode read-only. Gated actions go only through a daemon. Later: run the daemon's Rust core on the phone so there is still one interlock. Add Kotlin to codegen either way. |
| 3 | **High** | AI diagnosis | **The schematic → graph pipeline isn't connected.** Nothing in `cloud-api` queues `ai_worker.ingest_schematic`, and nothing reads Redis or Neo4j. The rules engine and the LLM evidence use `platform["shared_nodes"]` from `vehicle_registry.py`; `shared_graph_nodes` is never passed. Case matching through pgvector does work. | `grep` finds no Celery, Redis or Neo4j use in `services/cloud-api/app`; `ai_diagnostic_agent.py:90,154,318` | **ADR-B below.** Decide whether the topology graph is a launch feature. Either way, correct `docs/status.md` so Phase 3 isn't reported as done. |
| 4 | **High** | Deployment | **The cloud can't be deployed.** There are no Dockerfiles for `cloud-api`, `ai-worker` or `web`, no infrastructure-as-code, and no deploy job. Residency enforcement (`DATA_RESIDENCY_ENFORCE`) exists but nothing provisions ap-southeast-2. | `find . -name 'Dockerfile*'` and `*.tf` both find nothing | Add images and a minimal stack: managed Postgres with Timescale and pgvector, S3, a secrets manager, a container service for the API, and static hosting for the web app. Add a deploy job gated on CI. Leave out Neo4j and Redis unless ADR-B keeps them. |
| 5 | **High** | Repository | **The repository is public.** It holds the full security design (interlock, lease format, pairing), the test signing fixture and the immobilizer design doc. It's also the Kickstarter product's source. | `gh api repos/...` → `"visibility": "public"` | Make it private unless open-sourcing is intended, and if so, decide that deliberately. |
| 6 | Medium | Keys | **One Ed25519 key signs four kinds of token** (browser sessions, daemon leases, pairing tokens and immobilizer leases), told apart only by `aud`. The same key's public half is pinned in daemons and (with #15) the Android app. Rotating it for a web-session reason means shipping new daemons and apps. The key comes from an environment variable (`CLOUD_SIGNING_PRIVATE_KEY_HEX`), not the secrets-manager reference the plan names (`LEASE_SIGNING_KEY_REF`). | `services/cloud-api/app/services/signing.py:187,233,264,283` all use `PINNED_KID` | Split by trust level. A **device-trust key** (leases, pairing, immo) is pinned in daemons and apps and rotated rarely, per the runbook. A **session key** is never pinned and rotated freely. Load both from the secrets manager. |
| 7 | Medium | Web security | **Web sessions can't be revoked and the app sends no security headers.** Sessions are 12-hour bearer JWTs in `localStorage`. Logout doesn't revoke on the server; the per-request membership check limits the damage but doesn't revoke. `next.config.ts` sets no CSP or security headers, so an XSS bug would expose the session token. | `apps/web/src/context/auth.tsx:46-62`; `apps/web/next.config.ts` | Add CSP, `frame-ancestors 'none'`, `Referrer-Policy` and `X-Content-Type-Options` now. Then move to short access tokens with a refresh token in an httpOnly cookie, or keep a server-side session table so logout and "sign out everywhere" work. This also fixes Android's daily sign-in. |
| 8 | Medium | Daemon | **`server/ws.rs` is 1,700 lines.** It holds pairing, leases, streaming, the diagnostic channel map, audit sync and immobilizer handling. The next protocol work (Ford HS-CAN2 switching, Toyota sub-addressing, daemon-side discovery) all lands there. | `wc -l` | Split before that work, by concern: session/auth, adapter/connection, diag channels, streaming. Keep the interlock boundary where it is. |
| 9 | Medium | Diagnosis | **The LLM call runs inside the request.** It blocks an API worker for up to the Bedrock read timeout; a fallback exists and quota is refunded. Fine at launch volume. | `api/v1/diagnose.py:195-215`, `services/llm.py:80-98` | Measure p95 in production (the metrics exist). Move it to a job queue if it starts holding workers; this is a reason to keep the worker queue under ADR-B. |
| 10 | Medium | Discovery (#17) | **Module discovery runs in the browser,** at about 500 WebSocket round trips per sweep. The Android app can't reuse it, and the daemon can't batch it or use shorter timeouts. | `apps/web/src/lib/module-discovery.ts` (#17) | Later: a daemon `ModuleDiscoveryRequest` that streams results back. That gives one implementation for web and Android, and it fits ADR-A's direction. |
| 11 | Low | Diagnosis | **The rules engine computes an embedding it never uses** (`_embedding = embed_canonical_text(...)`), on every diagnosis. | `ai_diagnostic_agent.py:93` | Remove it. |
| 12 | Low | Data stores | **Four stateful services are planned** (Postgres/Timescale/pgvector, Neo4j, Redis, S3). Only Postgres and S3 carry production data today. | Finding 3 | See ADR-B. Each extra store is another backup, upgrade and residency check. |
| 13 | Low | Tests | **One end-to-end test fails about 3 runs in 8** on `main`. It's `session-flow.spec.ts` "a reload keeps the vehicle connected…". | Repeated runs, 2026-11-29 | Fix it before making e2e a required check (finding 1). Otherwise people learn to ignore red. |
| 14 | Low | Docs | **`docs/architecture.md` and parts of `docs/status.md` are out of date** (CI state, Phase 3). | Above | Update them with findings 1 and 3. |

## What's working well

- **Safety core.** Rule 3 is structural: links are crate-private and `DiagChannel` is the only way to send. Mutation tests prove a bypass fails the gate tests. Tokens are single-use and bound to an ECU. Preconditions fail closed.
- **Schema-first contracts.** Rust types are generated by typify and TS types by Zod from one JSON Schema, with parity fixtures and a drift check (`just codegen-check`). Android is the gap (finding 2).
- **Tenant isolation.** RLS is forced on every tenant table, the app runs as a non-owner role, and the tenant is set per transaction. A pooled connection reused across two tenants leaks nothing. Telemetry is isolated through a security-barrier view, because Timescale compression and RLS can't coexist.
- **Offline-capable licensing.** Leases are signed, short-lived and bound to a device and generation, so a workshop with no internet keeps working and a revoked plan stops paid features.
- **Operations groundwork.** There are Prometheus metrics, alert rules, a runbook for every alert, key-rotation and daemon-rollback runbooks, and a hardware-in-the-loop release checklist.

## Decisions this audit asks for

### ADR-A: How the Android app performs gated actions

**Status:** Proposed

**Context:** Rule 3 says every gated request passes the one `SafetyInterlock`, and A-CEO-4 says every gated attempt is audited. The daemon enforces both. Android's Bluetooth mode talks to the dongle directly with its own policy copy and no audit.

| | A1: Read-only Bluetooth | A2: Daemon core on the phone (Rust via JNI/UniFFI) | A3: Keep the Kotlin copy, add audit |
| --- | --- | --- | --- |
| Complexity | Low | High | Medium |
| Safety parity | Full (nothing gated runs) | Full: same interlock code | Partial: two implementations drift |
| Technician value | Reading and live data only | Full on a phone | Full on a phone |
| Maintenance | None | One codebase, extra build target | Two safety implementations forever |

**Recommendation:** A1 now (small change; leaves clearing codes to a daemon), then A2. A3 is the option the plan's rules exist to prevent.

### ADR-B: Is the circuit-topology graph in the launch product?

**Status:** Proposed

**Context:** The differentiator in the plan is root cause from circuit topology (shared grounds and fuses). The code has a schematic parser and a Neo4j repository, but nothing connects them to uploads or to diagnosis. Diagnosis today is rules plus pgvector case matching plus the LLM.

| | B1: Wire it up as designed | B2: Launch without it; graph in Postgres later | B3: Launch without it; keep Neo4j for later |
| --- | --- | --- | --- |
| Complexity | Medium–High (enqueue, worker writes graph, diagnose queries `TopologyRepository`, tenant isolation tests) | Low now | Low now, but carries Neo4j and Redis ops |
| Stores to run | Postgres, S3, Neo4j, Redis | Postgres, S3 | Postgres, S3, Neo4j, Redis |
| Product claim | Matches the plan | Must stop claiming topology RCA until built | Same as B2 |

**Recommendation:** B2, unless topology RCA is promised to Kickstarter backers at launch. Two-hop "shared fuse or ground" queries fit Postgres (an edge table plus recursive CTE), which keeps residency, backup and tenant isolation in one place. Keep the worker queue if the LLM moves off the request path (finding 9).

### ADR-C: Signing keys by trust level

**Status:** Proposed

**Context:** Finding 6. A key pinned in vehicle-facing software should change rarely and under the rotation runbook. A web-session key should be cheap to rotate.

**Decision (proposed):**
- **Device-trust key:** signs leases, pairing tokens and immobilizer leases. Pinned in the daemon and the app, rotated per `docs/runbooks/signing-key-rotation.md`.
- **Session key:** signs browser and app sessions. Never pinned; rotate at will.
- **Storage:** both loaded from the secrets manager.
- **Consequences:** a web-session incident no longer forces daemon and app releases. Two keys to manage.

## Suggested order

1. Format the ai-worker file and make CI required (finding 1). Same day.
2. Make the repository private (finding 5).
3. Make Android's Bluetooth mode read-only (ADR-A1) and add security headers (finding 7).
4. Decide ADR-B, and correct the status and architecture docs to match.
5. Deployable cloud: images, infrastructure as code, deploy job (finding 4), with the key split (ADR-C) built in.
6. Then the protocol work: split `ws.rs`, daemon-side discovery, HS-CAN2 switching and Toyota sub-addressing (findings 8, 10).
