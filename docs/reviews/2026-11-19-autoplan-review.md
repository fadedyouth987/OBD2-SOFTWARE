# gstack /autoplan review — Agentic Build Plan v2

- Date: 2026-11-19 · Plan: `docs/PLAN.md` (sha256 at intake c4a1da16…) · Restore point: `.gstack/tmp/autoplan/main-autoplan-restore-20261119-000819.md`
- Phases: CEO → Design → DX → Eng (UI and DX scope both detected by `gstack-autoplan-snapshot scope`)
- Outside voice: **unavailable** (Codex CLI not installed). All findings are in-host Claude; no consensus column is CONFIRMED.
- Run mode: runner-profile checklists, executed by hand from the installed skill files. The Claude Code `/autoplan` hook guard was not active in this session.
- Repo state: greenfield. Only `CLAUDE.md`, `.claude/` (gstack team mode) and `docs/` exist (commit f404c5d). Every "what already exists" answer is therefore "nothing in repo; reuse libraries".

---

## Phase 1 — CEO review (mode: HOLD SCOPE, with user challenges)

### 0A. Premise challenge

- **Real problem:** Australian workshop technicians lose hours on intermittent multi-module electrical faults and have no cheap way to spot odometer/VIN tampering across modules. Existing tools (OEM software, Autel/Launch scanners, FORScan, SavvyCAN) each cover part of this.
- **Target outcome:** connect any common adapter, get a trustworthy all-module scan + tamper audit in minutes, then an evidence-backed root-cause shortlist.
- **Do-nothing cost:** technicians keep stitching together 3–4 tools; no shared case history.
- **Does the plan hit the pain directly?** Partly. The edge daemon, scan and forensic audit hit it directly. The AI copilot (Phase 3) depends on two data sources that are empty on day one: resolved cases (pgvector) and wiring topology (Neo4j). Until enough cases exist and schematics are ingested, Phase 3 can only produce LLM text with nothing behind it.

| premise | claim | file:line receipt | verdict |
| --- | --- | --- | --- |
| P1 | Phases must run strictly in order 0→5 | docs/PLAN.md:12 | challenged (uc1, uc3) |
| P2 | Historical case retrieval gives useful matches | docs/PLAN.md:246 | unverified — corpus is empty at launch |
| P3 | Topology subgraph exists for the vehicle | docs/PLAN.md:226 | unverified — only generic seeds until a tenant uploads schematics |
| P4 | Programming-session and transfer services (Tier B) are needed in v1 | docs/PLAN.md:84 | challenged (uc2) — no task uses them |
| P5 | A 64-bit daemon can load J2534 drivers | docs/PLAN.md:98 | false — J2534 mandates 32-bit DLLs; most vendors ship only 32-bit |
| P6 | A browser page may connect to a localhost daemon | docs/PLAN.md:260 | true, with browser permission prompts; plan already handles the blocked state |

unverified=2

### 0B. Existing code leverage

Greenfield repo. Reuse at library level: `j2534-bridge` (out-of-process 32/64-bit J2534 bridge in Rust), `socketcan`/`socketcan-isotp`, `ed25519-dalek` + `jsonwebtoken` (EdDSA), PyMuPDF, pgvector, Stripe SDK webhook verification. No rebuilds of existing repo code are proposed.

### Reality rows

REALITY: premise-table finding 6 premises; P5 false, P2/P3 unverified, P1/P4 challenged docs/PLAN.md:12
REALITY: already-done pass greenfield repo, single commit, no plan files implemented f404c5d
REALITY: surface-check finding `edge-daemon pair` CLI and `/api/v1/auth/edge-pairing` are new surfaces with no registry yet; each needs a contract test docs/PLAN.md:54
REALITY: binding-decisions pass no prior decisions on branch; user decisions from v1→v2 fixes carried forward docs/PLAN.md:10
REALITY: numbers finding thresholds (+12% trim, 6 °C, 50 km, 2 s, 12.5 V, 20 Hz) are [estimated] domain heuristics, not measured; mark for field calibration docs/PLAN.md:83
REALITY: deferred-asks pass no linked issue; user asks (fix plan, run gstack) are all addressed docs/PLAN.md:1
REALITY: pr-count pass default one PR per wave; no ship-policy file yet CLAUDE.md:1

### 0C. Dream state delta

12-month ideal: a tech plugs in, the session auto-identifies the car, scans every module, flags tampering, and shows a ranked shortlist with the exact pins to probe, learned from thousands of anonymized Australian cases. The current plan reaches the plug-in → scan → audit part in Phases 0–1 + 4.1. The "learned from thousands of cases" part has no bootstrapping plan (no case-capture workflow, no seed corpus). Delta: add a resolved-case capture flow (tech marks the actual fix) — **added to the case-capture amendment (A-CEO-6)**.

### Sections 1–10 (findings)

1. **Architecture.** Diagram below. Single points of failure: the daemon (per workstation), the cloud signing key, the LLM endpoint. No protocol versioning between the always-latest web app and installed daemons → version skew breaks users silently. **WARNING → A-ENG-3.**
2. **Error & Rescue.** Gaps: LLM malformed/empty/refused/timeout output; duplicate or partial sync batches; Stripe webhook replays; lease expiring mid-session; PDF parser crash. Registry below. **CRITICAL GAP ×2 (LLM, sync) → A-CEO-1, A-CEO-2.**
3. **Security & threat model.**
   - Stripe webhooks are not signature-verified (High/High). → A-CEO-3
   - RLS bypass: table owner and superuser roles skip RLS unless `FORCE ROW LEVEL SECURITY`, and pooled connections can leak `app.current_tenant_id` (Med/High). → A-ENG-5
   - Neo4j has no row security; tenant filter lives in app code (Med/High). → A-ENG-6
   - Prompt injection through symptom text, DTC descriptions and uploaded PDF text (Med/Med). → A-CEO-1
   - Malicious PDF upload (decompression bombs, parser bugs) (Med/Med). → A-ENG-8
   - No audit trail of who actuated what on which vehicle (liability) (Med/High). → A-CEO-4
4. **Data flow & edge cases.** WS drop during a gated command; double-tap on confirm (handled by single-use token); browser tab closed mid-scan; adapter unplugged. A Tier B transfer interrupted mid-way can brick an ECU → uc2.
5. **Code quality.** Codegen tooling for schema parity is unspecified, so types would be hand-maintained in two languages. → A-DX-3
6. **Tests.** No hardware-in-the-loop check anywhere: every gate runs against simulators written by the same agent that writes the clients. → A-ENG-10
7. **Performance.** SQLite ring buffer has no size cap; Timescale has no retention/compression policy; a 500 kbit/s bus can exceed 3,000 frames/s [estimated]. → A-ENG-9
8. **Observability.** Nothing in the plan. Prime Directive 5 makes dashboards, alerts and runbooks launch scope. → new Task 5.2 (A-CEO-5)
9. **Deployment.** Cloud deploy target and daemon update channel are unspecified. → A-ENG-3, Task 5.2
10. **Trajectory.** Wire protocol and safety policy become one-way doors once daemons are installed (reversibility 2/5) → version both from day one (A-ENG-3).

### Error & Rescue Registry

| Codepath | What can go wrong | Class | Rescued? | Action | User sees |
| --- | --- | --- | --- | --- | --- |
| diagnose LLM call | malformed JSON / schema mismatch | `LlmSchemaError` | N ← GAP | retry once with repair prompt, then fall back | "AI summary unavailable — case matches and wiring shown" |
| diagnose LLM call | refusal / empty | `LlmRefusal` | N ← GAP | no retry; fall back | same as above |
| diagnose LLM call | timeout / 5xx / 429 | `LlmUnavailable` | N ← GAP | backoff ×2, then fall back | same; quota not charged |
| diagnose LLM call | cites node IDs not in the subgraph | `LlmUngroundedCitation` | N ← GAP | drop the cause, log | cause omitted |
| sessions/sync | duplicate batch | `DuplicateBatch` | N ← GAP | idempotent no-op by `batch_id` | nothing |
| sessions/sync | partial failure (S3 ok, DB fail) | `SyncPartial` | N ← GAP | transactional outbox; daemon keeps watermark | "Sync pending" badge |
| Stripe webhook | bad signature / replay | `WebhookSignatureError` | N ← GAP | 400, log, alert on burst | — |
| lease verifier | lease expires offline mid-session | `LeaseExpired` | partial | keep SILENT reads; refuse new ACTIVE tokens | "Pro features paused — reconnect to renew" |
| schematic ingest | parser crash / bomb / timeout | `IngestFailed` | N ← GAP | sandboxed worker, limits, mark page failed | per-page "couldn't read this page" |
| adapter I/O | unplugged mid-command | `AdapterError` | Y | `AdapterStatus: ERROR`, abort command | "Adapter disconnected — command not sent / outcome unknown" |

### Failure Modes Registry

| Failure | Trigger | Detection | Mitigation in plan | Gap |
| --- | --- | --- | --- | --- |
| Bricked ECU | Tier B transfer interrupted | — | gating only | refuse Tier B in v1 (uc2) |
| Cross-tenant leak | RLS bypass or pooled setting | RLS test | test only | FORCE RLS + SET LOCAL + pool test (A-ENG-5) |
| Daemon/web skew | web deploys new message type | none | none | protocol_version in Hello (A-ENG-3) |
| Stale speed on K-line | half-duplex bus can't poll speed while in target session | none | 2 s freshness rule | per-profile speed source (A-ENG-2) |
| J2534 unusable | 64-bit daemon, 32-bit DLL | none | none | 32-bit bridge (A-ENG-1) |
| Empty AI | no cases/topology | none | none | gate Phase 3 on data (uc1) + honest empty states |
| Silent cloud outage | no monitoring | none | none | Task 5.2 |

### NOT in scope (CEO)

- ECU flashing / programming (see uc2).
- Redistributing OEM wiring diagrams in the global graph; uploaded schematics stay tenant-private.
- Mobile-native apps; DoIP / CAN FD.
- Immobilizer key programming beyond AASRA-gated broker endpoints.

### What already exists

Nothing in the repo. External: OEM tools, FORScan, SavvyCAN, Autel/Launch scanners; `j2534-bridge`, `socketcan-isotp`, PyMuPDF, pgvector.

### Scope expansion decisions

HOLD SCOPE. One addition auto-accepted inside the blast radius: resolved-case capture (A-CEO-6), which is the only data source for Task 3.3.

### Diagrams

```
 Workshop PC                                         AWS ap-southeast-2
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────────┐
 │ Browser (Next.js app)                    │ HTTPS │ cloud-api (FastAPI)              │
 │   edge-client ──ws://127.0.0.1:8765──┐   │──────▶│  auth: lease + pairing (Ed25519) │
 └──────────────────────────────────────┼───┘       │  sessions/sync ─▶ TimescaleDB    │
 ┌──────────────────────────────────────▼───┐       │                 └▶ S3 (traces)    │
 │ edge-daemon (Rust service)               │       │  diagnose ─▶ pgvector · Neo4j ─▶ LLM
 │  ws server ─ pairing ─ lease verifier    │──sync▶│  billing (Stripe webhook)        │
 │  SafetyInterlock ◀── safety_policy.json  │       │  gateways (AASRA, AutoAuth)      │
 │  DiagTransport: ISO-TP │ K-line │ ELM    │       └──────────────┬───────────────────┘
 │  HAL: SLCAN STN FTDI SocketCAN ──┐       │                      │ Celery
 │  j2534-bridge (32-bit process) ◀─┘       │               ┌──────▼──────────┐
 │  SQLite WAL ring buffer + audit log      │               │ ai-worker       │
 └───────────────┬──────────────────────────┘               │ schematic ingest│
                 │ OBD-II / K-line / CAN                     └─────────────────┘
               Vehicle
```

Safety token state machine:

```
 NONE ──SafetyConfirmRequest (preconditions OK, lease OK)──▶ ISSUED(60 s, bound)
 ISSUED ──DiagCommandRequest w/ matching binding──▶ CONSUMED (single use)
 ISSUED ──expiry / disconnect / mode→SILENT──▶ REVOKED
 ISSUED ──binding mismatch──▶ (request refused TOKEN_INVALID; token stays ISSUED until expiry)
 CONSUMED ──any reuse──▶ refused TOKEN_INVALID      [impossible: CONSUMED→ISSUED]
```

### Stale diagram audit

No diagrams exist in the repo yet. The diagrams above go in `docs/architecture.md` when Phase 0 lands (A-DX-2).

### CEO completion summary

Mode HOLD SCOPE. 10 sections reviewed, 1 skipped by design (Section 11 handed to Phase 2). Critical gaps: 2 (LLM failure handling, sync idempotency), both auto-fixed. User challenges: 3 (uc1–uc3). unverified=2.

<!-- autoplan-accepted:ceo -->
- A-CEO-1 LLM failure handling + prompt-injection containment in Task 3.3, with tests for malformed, empty, refused, timeout and ungrounded-citation outputs.
- A-CEO-2 Idempotent sync (`batch_id`, watermark, transactional outbox) in Task 2.2, with duplicate and partial-failure tests.
- A-CEO-3 Stripe webhook signature verification + event-id idempotency in Task 2.3, with replay and bad-signature tests.
- A-CEO-4 Gated-command audit log (daemon-local, synced to cloud) in Tasks 1.2/2.1, with a test that every gated attempt (allowed or refused) writes one row.
- A-CEO-5 New Task 5.2 Observability and operations.
- A-CEO-6 Resolved-case capture flow (Tasks 2.2, 4.3).
<!-- /autoplan-accepted:ceo -->

---

## Phase 2 — Design review

No DESIGN.md exists. Scores 0–10 (10 = ready to build without design questions).

| Pass | Score | Key finding | Decision |
| --- | --- | --- | --- |
| 1 Information architecture | 4 | Pages are tool-centric (live, CAN studio, copilot). A technician's unit of work is a **vehicle session**: connect → identify → scan all modules → results → drill down. | A-DES-1 session-centric IA |
| 2 Interaction states | 3 | No loading/empty/error/partial states except connection status. | A-DES-2 state table per screen |
| 3 Journey & emotional arc | 5 | Safety confirm is the riskiest moment; plan specifies data but not the copy or friction level. | A-DES-3 confirm copy + hold-to-confirm for Tier A |
| 4 AI slop risk | 4 | "Ranked root-cause cards" with confidence numbers invites false precision. | A-DES-4 evidence-first cards |
| 5 Design system alignment | 2 | No design system. | A-DES-5 run /design-consultation before Phase 4 |
| 6 Responsive & accessibility | 3 | Workshop use (laptops, tablets, glare, gloves) not mentioned; red/amber/green severity relies on color alone. | A-DES-6 workshop-ready baseline |
| 7 Unresolved decisions | 5 | CAN studio only covers 11-bit IDs (0x000–0x7FF); 29-bit IDs are common on trucks and some cars. | A-DES-7 29-bit support |

Lowest pass score: **2** (design system).

User flow:

```
 [Connect]──adapter found──▶[Identify vehicle (VIN, profile)]──▶[Auto-scan all modules]
     │ no daemon / blocked / unpaired → fix-it states        │ partial: some modules silent → listed as "no response"
     ▼                                                        ▼
 [ConnectionStatus help]                           [Session overview: DTCs · tamper audit · alerts]
                                                     ├──▶[Live data]──gated action──▶[Safety confirm]──▶[Result/NRC]
                                                     ├──▶[CAN studio]
                                                     └──▶[Copilot: evidence cards + wiring graph]──▶[Mark actual fix]
```

State coverage required (A-DES-2):

| Screen | Loading | Empty | Error | Partial | Success |
| --- | --- | --- | --- | --- | --- |
| Session overview | scanning N/M modules | no DTCs ("all clear" + audit result) | adapter lost | some modules no response | results |
| Live data | waiting first sample | PID unsupported by ECU | stream stalled > 2 s | some PIDs unsupported | streaming |
| CAN studio | capturing | bus silent | adapter error | buffer full | matrix |
| Copilot | analyzing | no similar cases / no topology | AI unavailable (fallback) | topology generic only | evidence cards |

NOT in scope (design): pixel mockups in this run (no design binary output was requested); mobile-phone layouts.
What already exists: nothing in repo.
Approved mockups: none (A-DES-5 produces DESIGN.md first).

<!-- autoplan-accepted:design -->
- A-DES-1 Vehicle-session IA with a session overview page.
- A-DES-2 Per-screen state table implemented and covered by Playwright.
- A-DES-3 Safety confirm names action, ECU and consequence; hold-to-confirm 1.5 s.
- A-DES-4 Copilot cards show evidence (case IDs, graph nodes) and a qualitative confidence band, not raw percentages.
- A-DES-5 DESIGN.md via /design-consultation before Task 4.1 starts.
- A-DES-6 Workshop baseline: 44 px touch targets, WCAG AA contrast, dark mode, severity with icon + text, keyboard operable.
- A-DES-7 CAN studio handles 29-bit IDs.
<!-- /autoplan-accepted:design -->

---

## Phase 2.5 — DX review

**Developer persona:** an autonomous coding agent (and Brooke supervising it) building from `docs/PLAN.md` in a fresh container, sometimes without Docker or hardware.

**Empathy narrative:** The agent clones the repo, reads Task 0.1, and finds no pinned toolchains, no single command to start the stack, and a gate that assumes Docker. In Phase 1 it writes both the simulator and the client, so its tests can't catch a shared misunderstanding. When the web app can't reach the daemon, the error says "UNAUTHENTICATED" with no hint about pairing.

**Competitive DX benchmark:** SavvyCAN (download and run, minutes), python-can (pip install, virtual bus in 3 lines), FORScan (installer + adapter). Target: comparable for contributors.

**Magical moment:** `just dev` → browser opens → virtual E90 streams live RPM within 60 s.

**Journey map:** clone → toolchains → `just dev` → pair (dev shortcut) → virtual vehicle streaming → run tests → make a change → CI.

**First-time confusion report:** (1) Which Node/Rust/Python versions? (2) How do I pair in dev without a cloud? (3) Where do generated types come from? (4) No Docker here — what now? (5) What does `PRECONDITION_UNKNOWN` want me to do?

**TTHW** (time to hello world): current [estimated] 60+ min; target ≤ 15 min.

| DX dimension | Score | Fix |
| --- | --- | --- |
| Getting started | 3 | A-DX-1 `just dev`, pinned toolchains, README quickstart |
| API/CLI design | 6 | `edge-daemon pair --dev` for local dev |
| Errors & debugging | 5 | A-DX-4 `hint` field on ErrorResponse; daemon diagnostics bundle |
| Documentation | 3 | A-DX-2 README, architecture.md, protocol doc generated from schema |
| Upgrade path | 4 | A-ENG-3 protocol versioning |
| Environment & tooling | 4 | A-DX-3 codegen tools named; no-Docker fallback for gates |
| Community | n/a | private project |
| Measurement | 2 | Task 5.2 |

DX implementation checklist: see accepted block.

<!-- autoplan-accepted:dx -->
- A-DX-1 `justfile` with `dev`, `test`, `lint`; `rust-toolchain.toml`, `.node-version`, `uv` + Python 3.12 pinned; TTHW ≤ 15 min verified by a CI job that runs the quickstart.
- A-DX-2 README quickstart + `docs/architecture.md` (diagrams from this review) + protocol reference generated from `edge_ws.schema.json`.
- A-DX-3 Codegen: JSON Schema is the source; Rust types via `typify`, TS Zod via `json-schema-to-zod`; CI fails on drift.
- A-DX-4 `ErrorResponse.hint` (one-line fix-it text) for every code.
- A-DX-5 Gates that need Docker have a documented no-Docker path (testcontainers skipped with a clear message, or a hosted CI run) so a sandboxed agent is never stuck.
<!-- /autoplan-accepted:dx -->

---

## Phase 3 — Eng review (always last)

### Scope challenge

Reviewed the amended plan (CEO, design, DX amendments). The plan adds every module new (greenfield), so the design-twice pass applies to the one boundary with real alternatives: the shared schema source.

**Two shapes for schema parity:**
- A) JSON Schema is the source → generate Rust (`typify`) and TS (`json-schema-to-zod`). Language-neutral; Python can consume the same file. Red flag: `typify` output for tagged unions needs review.
- B) Rust types are the source → `schemars` emits JSON Schema → generate Zod. Rust-ergonomic. Red flag: the source of truth lives inside one service.
- **Chosen: A** (explicit, neutral; P5 explicit over clever).

### Reality rows

REALITY: premise-table finding J2534 bitness premise false; K-line speed freshness premise unverified docs/PLAN.md:98
REALITY: already-done pass greenfield, nothing implemented f404c5d
REALITY: surface-check finding new CLI `edge-daemon pair` and routes `/api/v1/auth/edge-pairing`, `/api/v1/sessions/sync` need contract tests docs/PLAN.md:201
REALITY: binding-decisions pass CEO/design/DX accepted blocks carried in docs/reviews/2026-11-19-autoplan-review.md:1
REALITY: numbers finding the plan's rate, size and timing limits (streaming rate, freshness window, token expiry, lease length, message cap) are [estimated] design limits, not measured docs/PLAN.md:173
REALITY: deferred-asks pass none docs/PLAN.md:1
REALITY: pr-count pass one PR per phase wave docs/PLAN.md:12
REALITY: prior-art pass adopt j2534-bridge (out-of-process 32/64-bit bridge) docs/PLAN.md:98
REALITY: dependency-fallback pass Phase 3 has a fallback (case-only, then no-AI) if topology absent docs/PLAN.md:240
REALITY: contract-assumptions finding pgvector iterative index scans assume pgvector ≥ 0.8 in timescaledb-ha:pg16; verify the bundled version in Task 0.1 docs/PLAN.md:34
REALITY: obligation-tiers pass must-ship = A-CEO-1..4, A-ENG-1..6; next = A-DES-*, A-DX-*; deferred = Phase 3 pending uc1 docs/PLAN.md:240

### Findings (Sections 1–4)

1. **Architecture**
   - A-ENG-1 **J2534 bitness.** Run J2534 DLLs in a 32-bit bridge process (adopt `j2534-bridge`), add an `i686-pc-windows-msvc` build of the bridge to releases.
   - A-ENG-2 **K-line speed precondition.** K-line is half-duplex with one ECU session at a time, so PID 0x0D can't be polled while talking to DSC. Each profile's `did_maps` declares a speed source (target ECU local ID, or re-init to the DME); if no value fresh enough for the Tier A rule (docs/PLAN.md:83) can be had, refuse with `PRECONDITION_UNKNOWN`.
   - A-ENG-3 **Versioning.** `protocol_version` + `policy_version` in Hello; daemon rejects unsupported major versions with `hint: "Update the edge daemon"`; web shows an update banner. Daemon auto-update is signed and staged (Task 5.1).
2. **Code quality**
   - A-ENG-4 One `SafetyInterlock::check()` entry that every transport path calls; no per-transport gating (prevents bypass through a new adapter).
3. **Security in code paths**
   - A-ENG-5 RLS: `FORCE ROW LEVEL SECURITY` on all tenant tables; app connects as a non-owner role; tenant set with `SET LOCAL` inside each transaction; test reuses one pooled connection across two tenants.
   - A-ENG-6 Neo4j: all Cypher goes through one repository module that injects the tenant filter; lint/test forbids raw driver use elsewhere.
   - A-ENG-7 pgvector: filtered HNSW can return fewer than 5 rows; enable iterative index scans (pgvector ≥ 0.8) or widen the filter in a second query; test asserts 5 results when 5 eligible rows exist.
   - A-ENG-8 Schematic ingest: max 50 MB / 200 pages per upload, per-page timeout (default one minute) [estimated], worker runs with no network and a memory cap.
4. **Performance**
   - A-ENG-9 SQLite ring buffer cap (default 2 GB) evicting oldest synced rows first, never unsynced rows; Timescale compression after 7 days and retention per tier.

### Test plan

Written to `~/.gstack/projects/obd2-diag/test-plan-2026-11-19.md`. Summary of codepath → test:

```
 safety_policy.json ─▶ interlock.check ─▶ every transport     [unit, table-driven over the file]
 token lifecycle (state machine above)                        [unit: issue/consume/expire/revoke/mismatch]
 K-line speed source per profile                              [integration: virtual E90 pre-03/2007]
 WS handshake (Origin/Host/Hello/pair/version)                [integration + security suite]
 lease + pairing JWT cross-language                           [fixture: Python signs, Rust verifies]
 sync idempotency + outbox                                    [integration: duplicate, partial failure]
 RLS + pooled connection reuse                                [integration: two tenants, one connection]
 Neo4j tenant filter                                          [integration + lint]
 LLM fallback paths (5 failure classes)                       [unit with stubbed endpoint]
 Stripe signature + replay                                    [unit]
 UI state table (A-DES-2)                                     [Playwright per state]
 HIL release checklist                                        [manual, real adapters, before each release]
```

A-ENG-10 **Hardware-in-the-loop release gate:** before any release, a manual checklist on a bench: STN2120 on CAN, K+DCAN on a K-line ECU, one J2534 adapter through the bridge; plus one real-car capture per profile added as fixtures.

### Worktree parallelization strategy

After Phase 0, three lanes can run in parallel worktrees (pending uc3):
- Lane A: Phase 1 (daemon)
- Lane B: Phase 2 (cloud) — joins Lane A at the Task 2.2 ↔ 1.4 JWT fixture
- Lane C: DESIGN.md (A-DES-5), then Phase 4 against the daemon's virtual bus
Phase 3 starts when uc1's data gate is met.

### NOT in scope (eng)

CAN FD, DoIP, macOS daemon builds, multi-adapter simultaneous sessions.

### Unresolved decisions

uc1, uc2, uc3 (owner: Brooke).

### Eng completion summary

4 sections reviewed; design-twice applied to schema source (A chosen). 10 accepted engineering amendments; 1 false premise corrected (J2534); test plan on disk.

<!-- autoplan-accepted:eng -->
- A-ENG-1 32-bit J2534 bridge process (adopt j2534-bridge) + i686 bridge build.
- A-ENG-2 Per-profile speed source for K-line preconditions.
- A-ENG-3 protocol_version/policy_version negotiation + signed staged daemon updates.
- A-ENG-4 Single SafetyInterlock::check entry for all transports.
- A-ENG-5 FORCE RLS, non-owner role, SET LOCAL, pooled-connection test.
- A-ENG-6 Single Neo4j repository with enforced tenant filter.
- A-ENG-7 pgvector iterative scan / widen fallback with 5-result test.
- A-ENG-8 Schematic ingest limits and sandbox.
- A-ENG-9 Ring buffer cap and Timescale compression/retention.
- A-ENG-10 Hardware-in-the-loop release checklist + real-car fixtures.
<!-- /autoplan-accepted:eng -->

---

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Mode HOLD SCOPE | Mechanical | P1 | Plan is complete; issues are gaps, not scope | EXPANSION, REDUCTION |
| 2 | CEO | Add LLM failure handling (A-CEO-1) | Mechanical | P1 | Unrescued errors | — |
| 3 | CEO | Idempotent sync (A-CEO-2) | Mechanical | P1 | Unrescued errors | — |
| 4 | CEO | Stripe signature verification (A-CEO-3) | Mechanical | P1 | Security | — |
| 5 | CEO | Gated-command audit log (A-CEO-4) | Mechanical | P2 | Liability, in blast radius | — |
| 6 | CEO | Observability Task 5.2 (A-CEO-5) | Mechanical | P1 | Prime Directive 5 | — |
| 7 | CEO | Case-capture flow (A-CEO-6) | Taste | P2 | Only data source for 3.3 | defer to later |
| 8 | CEO | Re-sequence and gate Phase 3 on data | User Challenge | — | Premise P2/P3 unverified | — (uc1) |
| 9 | CEO | Refuse Tier B in v1 | User Challenge | — | No feature needs it; brick risk | — (uc2) |
| 10 | Design | Session-centric IA (A-DES-1) | Taste | P5 | Matches technician workflow | tool-centric pages |
| 11 | Design | A-DES-2…7 | Mechanical | P1 | Missing states and accessibility | — |
| 12 | DX | A-DX-1…5 | Mechanical | P5 | TTHW and parity | — |
| 13 | Eng | Schema source = JSON Schema | Taste | P5 | Neutral, explicit | Rust-first schemars |
| 14 | Eng | A-ENG-1…10 | Mechanical | P1/P5 | Correctness/security | — |
| 15 | Eng | Parallel lanes after Phase 0 | User Challenge | — | Changes Rule 1 | — (uc3) |
| 16 | Eng | Keep web app + local daemon (not a desktop shell) | Taste | P3 | SaaS updates; pairing already solved | Tauri desktop app |

---

## Phase 4 — Final approval gate

**Plan summary:** v2 is sound on safety and security after the earlier fixes. This review adds 28 accepted amendments (6 CEO, 7 design, 5 DX, 10 eng), corrects one false premise (J2534 bitness), and raises three decisions that change your stated direction.

**User challenges (need your approval):**
- **uc1 — Ship the scan-and-audit product before the AI copilot.** Build Phases 0, 1, 2.1–2.2 and 4.1 first, release it, and start Phase 3 only once there's data: at least 200 resolved cases or a tenant with ingested schematics [estimated threshold]. Why: the copilot has no cases and no wiring data on day one. Cost if wrong: the AI ships a few weeks later than planned.
- **uc2 — Refuse Tier B (programming/transfer) services entirely in v1.** No task uses them, and an interrupted transfer can brick an ECU. Cost if wrong: a later flashing feature has to re-enable them deliberately.
- **uc3 — Allow parallel lanes after Phase 0.** Rule 1 says strictly sequential; daemon, cloud and design work are independent until the JWT fixture. Cost if wrong: integration surprises at the join point, caught by the shared fixture.

**Taste decisions (auto-decided, shown for visibility):** d1 case-capture flow added; d2 session-centric IA; d3 JSON Schema as the source; d4 keep web + daemon architecture.

Reply `rec` to take all recommendations (uc1–uc3 approved), `as-is` to keep the plan unchanged apart from the accepted amendments, or pick per item (for example `uc1 yes, uc2 yes, uc3 no`).
