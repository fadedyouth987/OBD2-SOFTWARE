# Build status

Progress through [`PLAN.md`](PLAN.md), in Rule 1 order. A task is done when its Verification Gate and review amendments pass; anything not verified is listed here, not hidden.

| Task | Status | Evidence |
| --- | --- | --- |
| 0.1 Scaffold and local infrastructure | Done | `just infra-gate` passed on 2026-11-19 (Docker in the agent sandbox): Postgres with timescaledb 2.32.0 and vector 0.8.7, Neo4j with APOC, Redis, S3 bucket. The run caught a real bug, fixed in the same change: the Neo4j image turned the health-check `NEO4J_PASSWORD` variable into an unknown config setting and refused to start. The `quickstart` CI job still has not run (GitHub Actions is not starting jobs on this account). |
| 0.2 Wire schemas and safety policy | Done | 52 parity tests (Rust + vitest), `just codegen-check` drift gate. |
| 1.1 HAL and virtual vehicles | Done, with hardware items open | See below. |
| 1.2 Transports, clients, safety interlock | Done | See below. |
| 1.3 Edge heuristics, CAN RE, ring buffer | Done | See below. |
| 1.4 Secured WebSocket server, lease verifier | Done | See below. Phase 1 complete. |
| 2.1 Multi-tenant schema with RLS | Done | See below. |

## Task 1.1 detail

Gate (`cargo test --package edge-daemon hal::`, 38 tests):

- CAN round trip on `VirtualBusAdapter`: `hal::virtual_bus::tests::can_round_trip_between_adapters`.
- K-line fast init and byte round trip on `VirtualKLineAdapter`: `hal::virtual_kline::tests::fast_init_and_byte_round_trip`.
- SLCAN and STN2120 byte streams parse, including STN K-line responses: `hal::slcan_serial::tests::recorded_flipper_session`, `hal::stn_elm::tests::recorded_stn2120_can_session`, `hal::stn_elm::tests::recorded_stn2120_kline_session`.

Also covered: the four virtual profiles (timing, NRC 0x78, SecurityAccess lockout, BMW D-CAN extended addressing, single K-line session per A-ENG-2, S3/P3 timeouts), K+DCAN fast and 5-baud init with echo checking, SocketCAN frame and filter conversion, adapter discovery.

A-ENG-1 (J2534 through a separate 32-bit bridge): `apps/j2534-bridge`. The daemon's `J2534Adapter` drives the real bridge binary in `j2534-bridge/tests/round_trip.rs` (loopback device). The Windows PassThru backend type-checks and passes clippy for `i686-pc-windows-msvc`; the `j2534-bridge-windows` CI job runs the round trip as 32-bit once Actions works.

Open items (need hardware or access this sandbox does not have):

| Item | Why open | Closes with |
| --- | --- | --- |
| Recorded byte streams are hand-built from the LAWICEL, ELM327/STN and ISO 14230 documents, not captured from devices | No adapters attached here | A-ENG-10: one real capture per adapter replaces each fixture |
| STN K-line header: the ELM327 is assumed to fill in the ISO 14230 length bits (`ATSH 80 12 F1`) | Not checkable without a chip | A-ENG-10 STN2120 K-line check |
| MS-CAN switching on STN returns `Unsupported` | The plan requires verifying the `STP` numbers against the STN reference before coding them | Verify against the STN command reference, then implement |
| J2534 against a real vendor DLL | Needs Windows and a PassThru device | `J2534_TEST_DLL=... cargo test -p j2534-bridge -- --ignored` on the A-ENG-10 bench |
| SocketCAN on a live interface | No `vcan` in the sandbox | `cargo test -p edge-daemon -- --ignored socketcan` |
| Windows CI job | GitHub Actions is not starting jobs on this account | Fix Actions (billing or repo Actions settings) |

## Task 1.2 detail

Gate (`apps/edge-daemon/tests/diag_gate.rs`, public API only, against the virtual vehicles):

- ISO-TP reassembles a 103-byte response with BlockSize 4 and STmin 5 ms honoured: `isotp_reassembles_large_response_with_block_size` (plus send- and receive-side unit tests in `protocols::isotp`).
- KWP2000 fast init + 0x1A on the virtual pre-03/2007 E90 DME: `kwp2000_fast_init_and_identification_on_e90_dme`.
- BMW D-CAN extended addressing round trip on the 03/2007+ E90 DME (and DSC): `bmw_dcan_extended_addressing_round_trip`.
- Every service in `safety_policy.json` refused in SILENT, on ISO-TP, K-line and STN/ELM, with nothing reaching the bus (A-ENG-4): `every_gated_service_refused_in_silent_on_every_transport` and `safety::interlock::tests::every_gated_service_refused_in_silent`.
- Expired, reused and mismatched tokens refused; unknown or > 2 s old speed refused: `safety::interlock::tests::token_lifecycle`, `speed_must_be_known_fresh_and_zero`.
- SecurityAccess halted after NRC 0x35, and after 0x36/0x37 with the delay reported: `security_access_halts_end_to_end`.
- NRC 0x78 then positive succeeds: `response_pending_then_positive_succeeds`.

A-ENG-4 is structural: links are crate-private and `DiagChannel` is the only public way to send a request, so every transport goes through `SafetyInterlock::check()`. A mutation check (bypassing the call) fails four gate tests.

A-CEO-4: every gated attempt (allowed or refused), every token issued or refused, and the ECU's answer with its NRC are written to the audit sink (`safety::audit`, JSON lines on disk). **Open:** syncing to the cloud `audit_log` table lands with Tasks 2.1/2.2.

Assumptions to confirm on hardware:

- After NRC 0x36/0x37 the interlock halts SecurityAccess for 10 s (`DEFAULT_SECURITY_DELAY`), since ECUs do not report their delay. NRC 0x35 halts it for the rest of the session.
- A plain ELM327 only listens while a command runs, so a final answer that comes long after NRC 0x78 can be missed on CAN; STN chips and the other adapters are not affected.

## Task 1.3 detail

Gate:

- Exact `HeuristicAlert`s from fixtures (`apps/edge-daemon/fixtures/heuristics/`, expected alerts written by hand from the rules): vacuum leak, odometer mismatch, recently cleared ECU, unsupported vehicle, plus cold-soak divergence. `tests/heuristics_gate.rs::fixtures_produce_exact_alerts`; every alert also passes the wire schema.
- The same audit end to end on the virtual vehicles: rolled-back cluster and freshly cleared codes on the Falcon, a VIN-swapped CAS on the D-CAN E90.
- Window-switch toggle log: `analytics::can_re::tests::window_switch_toggle_log`. On the generic vehicle's broadcast frames it finds the switch as a boolean, both rolling counters, the CRC byte (block score 0.88), RPM as continuous and the rest static; baseline-vs-action isolates exactly the switch bit.

A-ENG-2: each vehicle map names its speed source. On the K-line E90 a DSC session has no speed without re-initializing to the DME, so gated requests get `PRECONDITION_UNKNOWN` (`kline_speed_source_refuses_without_fresh_speed`); a DME session reads PID 0x0D itself.

A-ENG-9: the SQLite WAL ring buffer evicts the oldest synced rows at the cap (default 2 GB) and never unsynced ones; with only unsynced data left it refuses the write (`storage::ring_buffer::tests::cap_evicts_oldest_synced_never_unsynced`). Timescale compression and tier retention are the Task 2.1 half.

Notes:

- READ's magnitude rule can split one physical signal into adjacent fields (RPM shows as two continuous fields); the Task 4.2 studio should let the technician merge them.
- The ByCAN block score θ = b × u uses our own concrete definitions of b (edge sharpness) and u (flip-rate uniformity), documented in `can_re.rs`.
- VIN and odometer identifiers in `did_maps` follow the simulator's convention (0xF190, 0xDD01); real per-make identifiers replace them as vehicles are added (A-ENG-10 captures).
- Bundled SQLite needs the MSVC compiler to build for Windows, so the Windows type-check of the daemon now runs only on the Windows CI job; the bridge is still checked locally.

## Task 1.4 detail

Gate (`apps/edge-daemon/tests/ws_gate.rs`, real WebSocket clients against the server on a loopback port):

- Pair a client, list adapters, connect to the virtual bus, receive `ObdPidStream` and `CanFrameBatch` at ≥ 20 Hz each: `pair_list_connect_and_stream_at_20hz` (also runs an ungated read and a SAFETY_BLOCKED gated command over the socket).
- Rejected: disallowed `Origin` and wrong `Host` (HTTP 403 at upgrade), no Hello in time and `DiagCommandRequest` before Hello (`UNAUTHENTICATED` then close; the default timeout is 5 s), reused pairing code, lease signed by an unknown key, expired lease (`auth::lease` unit tests, and at the server: such a lease leaves the session at COMMUNITY).

Also covered: cloud pairing JWTs bound to the page's origin (native clients must use local codes), 1 MiB message limit, 20 `DiagCommandRequest`/s, `service_id` must match the payload's first byte, `LEASE_REQUIRED` for `ACTIVE_CONFIRMED` without `UDS_ACTIVE`, and A-ENG-3 on the daemon side (`VERSION_UNSUPPORTED` with an update hint for older and newer majors). The web-side update banner is Task 4.1.

The PID poll that feeds `ObdPidStream` also feeds the interlock its speed, RPM and battery readings, so Rule 5's freshness check runs on live data.

Found and fixed while building this: functional OBD requests (0x7DF) sent ISO-TP Flow Control to 0x7DF instead of the responder's physical id, so multi-frame functional answers stalled. `CanAddressing::Functional` now sends it to response id − 8 (ISO 15765-4), with a regression test.

Open items:

- **Cloud keys are not pinned yet.** `auth/cloud_keys.rs` is empty until Task 2.2's `signing.py` exports the production key, so leases and cloud pairing tokens cannot verify: the daemon runs at COMMUNITY tier with local pairing codes only. That is the safe default.
- Live sessions run on the virtual vehicles. Physical adapters need one bus shared between streaming and diagnostics; that lands with Task 4.1, and until then `ConnectRequest` to a physical adapter returns `ADAPTER_ERROR` with that explanation. K-line live view is in the same bucket.
- `DiagCommandRequest` channels use normal 11-bit addressing from `tx_id`/`rx_id`; BMW extended addressing over the socket comes with Task 4.1's vehicle-session flow.
- The ring buffer is not yet fed from live sessions; Task 2.2's sync wires it up.

Deviation: the plan lists `jsonwebtoken`. Its v12 needs a crypto backend that pulls in RSA for keys the daemon never uses, so leases and pairing tokens are checked by a small Ed25519-only JWS verifier (`auth/jws.rs`) on `ed25519-dalek`: one algorithm, pinned keys by `kid`, `alg: none` and HS/RS tokens refused.

## Task 2.1 detail

Gate (`services/cloud-api/tests/test_rls.py`, real Postgres: a throwaway database migrated as the owner, every check as the app role):

- Tenant A's vehicle is invisible to tenant B: `test_gate_tenant_a_vehicle_invisible_to_tenant_b`.
- A-ENG-5: `diag_app` is not the owner, not a superuser and has no BYPASSRLS; RLS is enabled and forced on every tenant table; the tenant is set per transaction (`set_config(..., true)`), and one pooled connection reused for two tenants leaks nothing, with no tenant left behind after the transaction (`test_pooled_connection_reused_across_tenants_leaks_nothing`). No tenant set means no rows and no writes.
- Every tenant table checked both ways, plus users (visible only to their tenants) and the shared case corpus (vector search through the cosine HNSW index).
- A-ENG-9: telemetry compressed after 7 days; `prune_telemetry_by_tier` (daily job) keeps 30 days for COMMUNITY, 365 for PRO, 730 for WORKSHOP [estimated defaults in `tier_retention`].
- A-CEO-4: `audit_log` holds one row per attempt (re-syncing a record is a no-op) and is append-only for the app role.
- A mutation check (migration without the RLS policies) fails six of the tests; the migration also downgrades cleanly.

Decisions:

- **Telemetry isolation uses a view, not RLS.** TimescaleDB cannot compress a table with row security, in either order, and A-ENG-9 requires compression. The app role has no privileges on the `telemetry_samples` hypertable; it reads and writes the `telemetry` view, a `security_barrier` view filtered on the current tenant `WITH CHECK OPTION` (inserts for another tenant are refused). Tests prove the same isolation as RLS.
- `resolved_cases` is the anonymized shared corpus (Task 2.2 strips tenant identity before publishing): any authenticated tenant reads it, inserts only, no updates or deletes.
- The owner role runs migrations and the retention job, so it must be a superuser or have BYPASSRLS (the dev `diag` role is a superuser); the app role never.
- `DATABASE_URL` is now the app role; migrations use `MIGRATION_DATABASE_URL`. `vehicles` stores only the VIN's HMAC-SHA256 (key from `VIN_HMAC_KEY_REF`: `env://` and `file://` work now; `secretsmanager://` is a configuration error until the deployment task) and VIN positions 1-9.
- CI now brings infrastructure up before `just test`, so these database tests run in CI instead of skipping.

Deviations from the Task 1.1 target paths, on purpose:

- `tokio-tungstenite`, `rusqlite` and `ed25519-dalek` were added by the tasks that use them (1.3, 1.4), not in 1.1, so no unused dependencies ship; `jsonwebtoken` was replaced (see Task 1.4).
- The Windows `j2534` dependency lives in `apps/j2534-bridge` (as the maintained fork `j2534-mrw`; `j2534` 0.3.1 no longer compiles), because A-ENG-1 moves DLL loading out of the daemon. `hal/j2534_win.rs` is the daemon's bridge client and builds on every OS.
- `serialport` is built without libudev, so the daemon needs no system packages; USB details for discovery may be missing on Linux.

## Remediation Update (Tasks 2.2–5.2 Scaffold & Core Modules Added)

| Task | Status | Notes |
| --- | --- | --- |
| 2.2 Control plane, signing, anonymizer, sync | Done, gate verified | `services/cloud-api/app/api/v1/{auth,sessions,dbc}.py`, `services/{signing,anonymizer,can_traces}.py`. Verification Gate run on 2026-11-26; see "Task 2.2 gate verification" below. |
| 2.3 Billing & AU MVIS/AASRA gateways | Implemented | `services/cloud-api/app/api/v1/{billing,gateways}.py` with Stripe HMAC verification & event idempotency. |
| 3.1–3.2 Neo4j tenant repo & PDF pipeline | Implemented | `services/ai-worker/app/{graph,vision,tasks}/` with A-ENG-6 tenant filter & A-ENG-8 50 MB/200-page limits. |
| 3.3 KG-guided RAG localizer | Implemented | `services/cloud-api/app/services/{embeddings,ai_diagnostic_agent}.py`, `api/v1/diagnose.py` (A-CEO-1 fallback, A-DES-4 bands). |
| 4.1 Edge client, pairing, live dashboard | Done, gate verified | Verification Gate run against the real daemon on 2026-11-27; see "Task 4.1 gate verification" below. |
| 4.2–4.3 CAN studio, copilot + `DESIGN.md` | Implemented | `DESIGN.md`, `edge-client.ts`, `SafetyConfirmModal.tsx` (1.5s hold), `BitFlipMatrix.tsx` (29-bit), `WiringTopologyViewer.tsx`, `/live`, `/can-studio`, `/copilot/[sessionId]`. |
| 5.1 Native installers and CI | Gate verified in CI; A-ENG-10 bench run and signing certificates open | `package.yml` and `quickstart.yml` green (release builds, install, post-install tests, upgrade, uninstall on Linux and Windows). See "Task 5.1 gate verification" below. |
| 5.2 Telemetry, runbooks | Implemented | `apps/edge-daemon/src/telemetry/`, `infra/monitoring/prometheus.yml`, `infra/monitoring/alerts.yml`, `docs/runbooks/`. Gate needs a staging drill (see below). |

Remaining verification requiring local host/hardware: `cargo test --workspace`, `pnpm --filter web build`, live Postgres/Neo4j integration tests, and physical `A-ENG-10` vehicle captures.

## Review amendment verification (2026-11-26)

Every amendment in [`reviews/2026-11-19-autoplan-review.md`](reviews/2026-11-19-autoplan-review.md) was checked against the code and its test. Gaps found were built and tested the same day. All suites were run against real Postgres, Neo4j, Redis and S3 containers.

| Amendment | Found | Done |
| --- | --- | --- |
| A-ENG-7, A-CEO-1 | `/diagnose` read every resolved case and filtered in Python (no vector search), and accepted cases and circuit nodes from the client as "evidence" the model could cite | Server-side pgvector search (iterative HNSW scan plus an exact second pass, ranked by shared codes, engine family, similarity, recency); client evidence ignored. Tests: 5 results when 5 eligible rows exist; forged client cases never reach the prompt |
| A-CEO-1 | No test per failure class | Tests for malformed, empty, refused, timed-out, unavailable and ungrounded-citation answers, prompt injection, and no charge on fallback |
| A-CEO-2 | No partial-failure test | A batch failing mid-way commits nothing; retry accepted once |
| A-ENG-8 | API allowed 300 pages; no per-page timeout; worker had no memory or network limits | 200-page cap everywhere; per-page timeout marks a page failed; worker memory cap and no network but the broker |
| A-ENG-6 | No check against raw Neo4j driver use | Test fails on any driver use outside `app/graph/neo4j_client.py` |
| A-CEO-5 (Task 5.2) | Only basic counters and one runbook | Rotating daemon log; `edge-daemon diagnostics` redacted support bundle; JSON logs with `X-Request-ID` web → API → worker; metrics for sync lag, diagnose latency and fallback rate, webhook and ingest failures, daemons by version, HTTP status by route; `infra/monitoring/alerts.yml` with a runbook per alert; signing-key rotation and daemon rollback runbooks |
| A-ENG-10 | No checklist | [`runbooks/hil-release-checklist.md`](runbooks/hil-release-checklist.md) |
| A-DES-1/2/3/4/6/7 gates | No browser tests | Playwright suite (`just e2e`, in CI): session flow, state table, copilot evidence, axe + 44 px targets in both themes. Component tests for the safety modal (copy, 1.5 s hold, fail closed on unknown or stale readings, hold stops mid-way). 29-bit CAN ID formatting unit test. The suite found and fixed one more daylight contrast failure (green badges) |

Already in place and confirmed: A-CEO-3, A-CEO-4, A-CEO-6, A-DX-1 to A-DX-5, A-ENG-1 to A-ENG-5, A-ENG-9, A-DES-5.

Still needs people or hardware: the A-ENG-10 bench run, a staging drill that fires each alert (the rules are checked by tests, not yet fired against a live Prometheus), and pinning a production signing key.

## Task 2.2 gate verification (2026-11-26)

The Task 2.2 row above was marked from `py_compile` only. Its Verification Gate was run against real Postgres and SeaweedFS; three contract items were missing and one sync bug was found. All are fixed and tested.

| Gate or contract item | Before | Now |
| --- | --- | --- |
| Lease and pairing tokens from `signing.py` verify in the Rust daemon with the pinned key (shared fixture); other keys or wrong `aud` rejected | No shared fixture: the Rust tests signed their own tokens | `packages/schemas/fixtures/signing/cloud_tokens.json`, issued by the real `signing.py` functions with a test-only key and a pinned clock (`services/cloud-api/tests/signing_fixture.py`), verified by `apps/edge-daemon/tests/cloud_token_fixture.rs`: lease (tier, features, `rcid`, `lease_ver`, expiry), pairing (origin-bound), immobilizer lease. Rejected: another key under the right `kid`, unknown `kid`, expired, pairing and session tokens as leases, a lease as a pairing token or immobilizer lease, an immobilizer lease as a diagnostic lease, anything with no pinned keys. `tests/test_signing_fixture.py` fails if the fixture drifts from `signing.py` |
| Raw CAN traces to S3 ap-southeast-2 | Not implemented: sync took telemetry and audit rows only | Optional `can_frames` on `POST /api/v1/sessions/sync`, in the edge's own `CanFrame` wire shape (`is_extended`, `dlc`, `data_hex` up to 8 bytes; unknown fields refused), stored as a gzipped candump log (`can_traces/<tenant>/<id>.log.gz`) through a transactional outbox (`can_trace_outbox`, migration 012). `tests/test_can_traces.py::test_gate_sync_stores_raw_can_trace_in_s3_with_vin_masked` checks the object byte for byte |
| Anonymizer removes VIN serials (raw traces) | Raw frames would have kept any VIN the car sent | ISO-TP responses to UDS F190 and OBD 09 02 are reassembled (normal and extended addressing) and VIN positions 10-17 are replaced with `*` in the frame bytes before storage (`mask_vins`, `test_vin_serial_is_masked_in_the_frames`). Manufacturer-specific VIN identifiers other than F190 are not masked yet |
| Compressed batches | Plain JSON only | `Content-Encoding: gzip` on the sync route (`app/api/gzip_body.py`), only for a caller whose session token verifies, inflated in a worker thread: 8 MiB compressed, 32 MiB inflated (413), corrupt, truncated or trailing data 400, other encodings 415; refusals carry CORS headers (`tests/test_sync_gzip.py`) |
| A-CEO-2 partial failure, S3 | No S3 step to fail | S3 refuses or hangs after commit: the batch is acknowledged with `traces_pending`, the trace stays in the outbox, `python -m app.cli drain-can-traces` uploads it later. The request uploads from memory with a short-timeout client and no transaction or lock held; the drain works row by row, retries least-failed rows first so one bad object cannot block the rest, stops after 3 failures in a row, refuses keys outside the row's tenant prefix, and exits 1 with the true backlog while anything is pending (`test_can_traces.py`). Migration 012 refuses to downgrade while traces are pending |
| A-CEO-2 re-sent records (bug) | An audit record re-sent in a new batch (the edge lost its ack) raised a unique violation and the route returned 409 on every retry, so that session could never sync again | Audit rows insert in one statement with `ON CONFLICT DO NOTHING`; a skipped row is compared with the stored record: an exact replay is skipped, a different record on a used `seq` (in the database or earlier in the batch) is a 409 that stores nothing from the batch, and an entry without an integer `seq` is a 422 (`tests/test_sync_resend.py`; a review probe showed the first version of this fix dropping such records silently) |

The plain JSON batches the web app's job recorder sends are unchanged (`test_batches_without_frames_are_unchanged`). Already covered on main and re-run: lease and pairing issuance, duplicate `batch_id`, database partial failure, anonymizer (`test_tasks_2_2_to_3_3.py`, `test_security.py`).

Open:

- Schedule `drain-can-traces` (every few minutes, owner database role) with the Task 5.2 jobs.
- The daemon does not send `can_frames` yet. When it does, a batch rebuilt after a lost ack must keep its `batch_id`; a new id stores the same frames (and telemetry, as before this change) twice.
- CAN trace objects are never deleted: no tier retention, and deleting a tenant or session drops the outbox rows but leaves the S3 objects. Add a lifecycle or delete path with the retention work.
- The web recorder's audit `seq` (`Date.now()*10 + audit.length`) can collide across tabs; a collision is now a 409 instead of a lost record, but the client should use a per-session counter.

## Task 4.1 gate verification (2026-11-27)

The existing Playwright suite drove the browser demo car, so the gate ("pairs with daemon on `VirtualBusAdapter`") had never run. `apps/web/e2e/daemon-gate.spec.ts` now runs it against the real debug daemon, in CI with the rest of `pnpm e2e`. The cloud API is stood in, but the pairing and lease tokens it hands the browser are real: `services/cloud-api/tests/edge_e2e_tokens.py` issues them with the production `signing.py` functions and a throwaway key that the run pins in the daemon (`EDGE_DEV_CLOUD_KEYS`, debug builds only).

| Gate or contract item | Before | Now |
| --- | --- | --- |
| Pairs with the daemon, live PIDs render, no console errors | Only the in-browser demo was tested | The browser fetches a cloud pairing JWT and sends `HelloRequest` first, installs the plan's lease, connects the virtual Falcon in Active mode, and the live page streams; no page or console errors (the run found the stand-in missing `/api/v1/team`) |
| Oscilloscope: RPM, MAF, STFT/LTFT B1/B2, ECT, IAT | SVG line charts, default RPM, speed, ECT, STFT B1; the daemon polled six PIDs and never sent MAF or the bank 2 trims | Canvas 2D oscilloscope (`components/charts/Oscilloscope.tsx`), one lane per PID with its own scale, the contract set by default. The daemon asks the ECU which PIDs it supports, then polls RPM, speed, MAF and the short-term trims every cycle and ECT, IAT and the long-term trims every fifth; PIDs the car doesn't report show as not supported (Rule 6) |
| Heuristic alert banner | Live alerts appeared only on the job overview | Also a banner per alert on the live page, severity in words and colour |
| Modal blocks until confirmed | Component test only | With the checklist ticked, letting go after 0.6 s sends nothing (the daemon's audit log is unchanged); a full hold gets a token, clears the codes, and the log shows `token_issued` and `allowed` |
| Unknown speed shows `PRECONDITION_UNKNOWN` | The modal said "waiting for a fresh reading" without the code | The modal names `PRECONDITION_UNKNOWN` and the reading it lacks, and the hold stays locked. Gate run on the Falcon with its speed PID removed (`EDGE_SIM_FAULTS=no-road-speed`, debug builds only); a client that skips the modal gets `PRECONDITION_UNKNOWN` from the daemon itself, logged as `token_refused`. The daemon no longer seeds a virtual vehicle's speed at connect unless the vehicle reports speed. Daemon refusals in the app now show the code after the plain words |
| Killed daemon shows "not running" | Unit test only | The daemon is killed mid-session; Devices shows "The edge daemon is not running", the start command and Retry now |
| `ConnectionStatus`: "browser blocked local connection" | Shown as "not running" | Its own state with the fix: a `SecurityError` when the socket is created (mixed content, CSP) or Chrome's local network access permission set to Block (`tests/edge-client.test.ts`) |

gstack `/review` (7 specialists, red team, adversarial pass) found and this change fixed: the daemon seeded speed and RPM from the simulator at connect instead of reading them from the bus, and kept readings across sessions (`end_session` now clears them; only bus reads count); the browser-permission probe also read Chrome's LAN-only permission and had no timeout (now loopback only, 500 ms, and a denied permission keeps retrying); long-term trims, now polled every fifth cycle, dropped 4 of 5 fuel-trim heuristic snapshots (carried forward now); an empty or unreadable supported-PID bitmap is logged instead of silently disabling the stream filter; the INFO "audit consistent" result no longer shows as a live banner; oscilloscope lanes print their min and max; `just e2e` and CI build the daemon before the gate, and a missing daemon fails the gate instead of skipping it. New tests: `ws_gate::streams_the_contract_pids_and_only_supported_ones`, `interlock::end_session_clears_the_live_readings`, `heuristics::long_term_trim_carries_into_later_snapshots`, and permission/SecurityError/stale-probe cases in `tests/edge-client.test.ts`.

Open:

- The contract names a Zustand store in `apps/web/src/store/diagnostic-store.ts`; the app keeps that state in a React context (`context/edge.tsx`). Same behaviour, different library: needs a decision before Task 4.2.
- A privacy extension or shield that kills the socket without a `SecurityError` still looks like "not running": the browser reports both the same way.
- K-line vehicles (the pre-03/2007 E90) can't be connected over the local WebSocket, so they have no live view.
- Not yet run against real adapters (A-ENG-10).
- None of the virtual vehicles raises a RED or AMBER audit alert over the WebSocket (the Falcon session reports VIN and odometer consistent, unlike the Task 1.3 fixture run), so live-banner rendering for those severities is covered by type checks, not by the gate.

## Task 5.1 gate verification (2026-11-27)

The row above was marked from the files existing. Checked against the contract, the installers could not have worked: the daemon had no Windows service entry point (the service manager stops such a process after about 30 s), the MSI set no allowed origin, and the Linux unit ran as root with `ProtectSystem=strict` and no writable data directory, trusting the development origin in production. Nothing built release binaries or tested an installed service.

| Gate or contract item | Now |
| --- | --- |
| Release builds for `x86_64-unknown-linux-gnu` and `x86_64-pc-windows-msvc` | `.github/workflows/package.yml` on every push and PR, plus the 32-bit J2534 bridge |
| Linux installer | `packaging/linux/install.sh`: systemd unit running as the `obd2-edge` user in `dialout`, service-only data in `/var/lib/obd2-edge` (0710, UMask 0077) with only `pairing/` (2770) shared with the `obd2-edge` group, production origin in `/etc/obd2-edge/edge-daemon.env` (kept on upgrade), udev rules, `uninstall.sh` (keeps data unless `--purge`) (D5) |
| Windows installer | MSI installs the `RootCauseEdgeDaemon` service (`edge-daemon service`) under its own virtual account `NT SERVICE\RootCauseEdgeDaemon`, restarted by the service manager after a failure, reporting Running only once the port is bound. Data in `C:\ProgramData\RootCauseOBD` for SYSTEM, Administrators and the service only; its `pairing\` subfolder is writable by the local group "RootCause Technicians" (created at install). Origin and data folder in the service's Environment; `edge-daemon` on PATH |
| Production `EDGE_ALLOWED_ORIGINS` | `https://app.rootcauseobd.com.au` only in both installers (D3) |
| Post-install smoke test | `scripts/smoke-installed-daemon.mjs`, run against the installed service on both runners: listens on loopback only, refuses a non-loopback address, refuses a client that skips Hello and a wrong code, accepts a code a technician made with `edge-daemon pair`, refuses WebSocket handshakes from `localhost:3000`, `127.0.0.1:3000` and another site while accepting the production origin, and started with exactly that origin. Also in CI: a technician (Linux: `obd2-edge` member with no profile environment; Windows: a standard user in "RootCause Technicians") pairs, a non-member can't, and neither can read or write the rest of the data folder; upgrade keeps the edited origin file; uninstall keeps data, `--purge` removes it; the Windows service restarts on request |
| Pairing in a shared install | Codes live in `<data dir>/pairing/pairing.json`, group-readable only in a setgid folder; `edge-daemon pair` finds the installed service's folder even without `EDGE_DATA_DIR`, says which folder it used, never opens the service's log file (`tests/cli_pair.rs`), and writes through unpredictable `O_EXCL` temp files (`fsutil`). After 5 wrong codes every outstanding code is cancelled and none is accepted for 30 s (`pairing::tests`) |
| Code signing | `sign-linux` and `sign-windows` jobs run only for `v*` tags, in the protected `release` environment, and fail if its secrets (`LINUX_SIGNING_KEY`/`LINUX_SIGNING_KEY_PASSPHRASE`, `WINDOWS_CERT_PFX`/`WINDOWS_CERT_PASSWORD`) are missing. Build jobs hold no secrets and have read-only repository access; the GPG passphrase goes through a pipe and the PFX into the job's certificate store, never onto a command line. Not yet run: no tag, no certificates (D4) |
| CI across Rust, Python, TypeScript | `quickstart.yml` (contract names `ci.yml`): `cargo test`, pytest against Postgres and Neo4j, `next build`, Playwright including the Task 4.1 daemon gate, schema and token fixture tests |

gstack `/review` (6 specialists, red team, adversarial pass) found the first installers shared the whole data folder: on Linux every `obd2-edge` member, and on Windows every local user, could rewrite the audit log, read or swap other technicians' leases and lower `lease.min_ver` to bring revoked leases back. Fixed as above (D1), with `lease.min_ver` now only ever raised. Also fixed: pairing-code guessing (D2), signing secrets reaching every build step on every branch (D3), the Windows service's shared LocalService account, missing restart, Running before the port was bound and unlogged bind failures, SIGTERM skipping the daemon's shutdown path on Linux, a release daemon falling back to the development origin when `EDGE_ALLOWED_ORIGINS` is missing (it now trusts the production origin only), and CI cost (concurrency, caching, `push` limited to `main` and tags) (D4).

Open:

- A-ENG-10: the hardware-in-the-loop release checklist is not signed off (needs the bench), so Task 5.1's amendments are not all met.
- Signing: create the `release` environment (required reviewers) and add its four secrets; the signing jobs have not run yet.
- Before pinning a production cloud key: a code-paired session gets the machine lease and any machine immobilizer lease (`leases_for`), and neither installer sets `EDGE_DEVICE_ID`, so device-bound leases are not checked against the machine.
- Windows: MSI repair or upgrade rewrites the allowed origins (Linux keeps a local edit); CI builds share version 0.1.0, so installing a newer CI build beside an older one leaves two products; the J2534 bridge loads vendor DLLs as the service account, which still holds SeImpersonate.
- Linux: the package assumes a `dialout` group (Arch uses `uucp`).
- Stopping or upgrading the service ends a live session without returning control to the ECU first; another local user can bind port 8765 while the service is stopped.

## Whole-site debug pass (2026-11-28)

Every route was loaded against the real local stack (Postgres, API, daemon, web in dev mode) signed out, signed in, and walked in-app with the virtual Falcon connected (scan, identify, live data, service functions, copilot, close-out, report), recording console errors, page errors and failed requests. No page crashed and no API call failed. Fixed:

- Reloading a page (or a daemon restart) dropped the vehicle connection. The tab now remembers its adapter and reconnects it read-only (SILENT) when the daemon session comes back; an explicit disconnect or an unplugged adapter clears it (`e2e/session-flow.spec.ts`).
- The Modules page showed 11 VIN characters while the job header showed 9: `lib/ident.ts` and key programming had their own masks. All use `lib/vin.ts` now (positions 10-17 hidden, as the cloud anonymizer does).
- Linux's built-in serial ports (`/dev/ttyS*`) were listed as OBD dongles. Discovery skips them; USB and Bluetooth serial ports stay (`discovery::tests::builtin_linux_uarts_are_not_adapters`).
- Unknown addresses showed Next.js's bare 404; they now get the app's own page with a way home (`e2e/states.spec.ts`).

Checked and not a bug: the virtual Falcon's audit reports VIN and odometer consistent because the simulated car is untampered by default (the Task 1.3 test injects the rollback). Noted: the simulator's Falcon VIN decodes to model year 1998 and has an invalid check digit, which a 2002-2005 BA wouldn't.

## Mobile app, Phase 6 (2026-11-27)

New scope, planned and reviewed in `docs/design/mobile-app.md` (owner decisions D1-D8). The plan proposes Phase 6 after Task 5.2; the owner asked to build it now.

Done:
- **Mobile plan** (A$15/month, A$150/year, 40 AI diagnoses, no desktop lease features). Every plan's prices, quotas and features, plus the app feature matrix, live in one file, `packages/schemas/plan_features.json`. `billing.py`, `signing.py`, the web billing page and the app all read it. A golden test keeps the four existing plans unchanged. Migration 013 adds `MOBILE` to the enum, with 90-day telemetry retention. The Workshop trial stays Community-only.
- **`packages/core`**: DTC, VIN and diag helpers moved out of the web app, whose imports switched in the same change. Also adds OBD-II mode 01 decoding.
- **`apps/mobile`** (Expo SDK 58, Android):
  - read-only scan (codes per module, readiness, VIN, freeze frame), live data, AI diagnosis with quota, customer report PDF;
  - recording and CSV export for Mobile and up;
  - a "Your plan" screen that marks every feature as included, locked or desktop-only;
  - Bluetooth LE and classic (a Kotlin module in the app);
  - a demo car;
  - an allow-list send guard (modes 01, 02, 03, 07, 09, 0A only; `safety_policy.json` as the second layer).
  - A failed read shows "Scan incomplete", never "no codes".
- **CI**: `mobile.yml` builds a debug APK artifact. `scripts/check-web-deps.mjs` fails lint if a web dependency version moves.
- **Web fix**: Disconnect now sticks across a reload. A reload or an in-flight connect used to bring the adapter back; this was the cause of the failing `session-flow` e2e.

Not done yet:
- App refresh tokens and the OIDC app redirect (T3); phone sessions still last 12 h.
- Screen-off recording via an Android foreground service (D7). Recording works while the app is open, with the screen kept awake, capped at 4 h.
- Play Store release (T7).
- A real-dongle field test. The APK is only verified by CI and the simulated car.
- Database-backed billing tests for Mobile were written but skip locally (no TimescaleDB here); CI runs them.

## Windows installer verified in CI (2026-11-27)

`package.yml` run 46063134287 (commit c98a7c5) passed on both platforms.

On Windows, every step ran:
- The MSI builds with WiX 4.0.5.
- It installs, and the service runs as `NT SERVICE\RootCauseEdgeDaemon` with an unrestricted SID and restart-on-failure. These were checked with `sc.exe`.
- The data folder is closed to users, and only the technicians group can write to `pairing\`.
- A standard user in that group can pair.
- The smoke test passes: the daemon listens on loopback only and refuses unpaired connections.
- The service stops and starts on request, and uninstall stops the daemon.

Three fixes got it there:
- the WiX 4 attribute names (`FailureActionsWhen`, `restartService`);
- service SID type and failure actions set by `sc.exe` custom actions instead of the MsiServiceConfig tables, which made a fresh install fail with 1603;
- a CI log that prints the failing action instead of the log's tail.

The signing jobs are skipped on pull requests, as designed: they run only for `v*` tags, once certificates exist.
