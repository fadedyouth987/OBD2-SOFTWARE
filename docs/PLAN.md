# Agentic Build Plan v2: Full-Stack AI Automotive Diagnostic SaaS

Source of truth: the "Agentic Build Plan v2" doc in the OBD2 SOFTWARE project. This file is the repo copy that coding agents and gstack reviews read.

## Implementation plan

### Agent operating rules

This is a deterministic build spec for an autonomous coding agent. Each task lists Target Paths, an Implementation Contract and a Verification Gate.

1. Execute tasks strictly one at a time, in this order (uc1, approved 2026-11-19):
   - **Release 1 (scan and audit):** Phase 0 → Phase 1 → Tasks 2.1, 2.2 → Task 4.1 → Tasks 5.1, 5.2.
   - **Then:** Task 2.3 → Task 4.2.
   - **AI copilot (Phase 3, then Task 4.3)** starts only when the data gate is met: at least 200 resolved cases in `resolved_cases` [estimated threshold], or at least one tenant with ingested schematics.
   Do not start the next task until the current Verification Gate passes with zero errors.
2. Never mock hardware protocols inside production adapters. Use the dedicated `VirtualBusAdapter` (vcan0 or in-memory loopback) for deterministic CI tests.
3. Every adapter starts in `SILENT` (read-only) mode. Any request matching `packages/schemas/safety_policy.json` must pass through `SafetyInterlock`. That file is the only list of gated services; code, UI and tests load it rather than copying it.
4. The local WebSocket is a privileged interface that can actuate a vehicle. The daemon processes no message except `HelloRequest` until the connection passes the Origin, Host and pairing-token checks in Task 1.4.
5. Safety checks fail closed. If vehicle speed, battery voltage or token state cannot be read, the gated request is refused.
6. A diagnostic check that is unsupported for the connected vehicle reports `INFO: not supported`. It never reports a pass.
7. Safety mode has one spelling everywhere: `SILENT` or `ACTIVE_CONFIRMED`.
8. The review amendments below are part of the named tasks' contracts and Verification Gates. A task is not done until its amendments pass too.

### Review amendments (gstack /autoplan, 2026-11-19)

Accepted from the CEO, design, DX and engineering reviews in `docs/reviews/2026-11-19-autoplan-review.md`. Brooke approved uc1 (Release 1 before the AI copilot, now in Rule 1) and declined uc2 (Tier B stays gated, not refused) and uc3 (tasks stay strictly sequential).

| ID | Task | Amendment | Added to the gate |
| --- | --- | --- | --- |
| A-DX-1 | 0.1 | `justfile` with `dev`, `test`, `lint`; pin `rust-toolchain.toml`, `.node-version`, Python 3.12 via `uv` | CI job runs the README quickstart; time to first live stream ≤ 15 min |
| A-DX-2 | 0.1 | README quickstart, `docs/architecture.md` with the review diagrams, protocol reference generated from the schema | Docs build in CI |
| A-DX-5 | 0.1 | Every gate that needs Docker documents a no-Docker path, so a sandboxed agent is never blocked | Path documented per gate |
| A-ENG-3 | 0.2, 1.4, 4.1 | `protocol_version` and `policy_version` in `HelloRequest`/`HelloResponse`; daemon refuses unsupported majors with an update hint; web shows an update banner | Version-mismatch test both ways |
| A-DX-3 | 0.2 | JSON Schema is the source: Rust types via `typify`, Zod via `json-schema-to-zod` | CI fails on generated-type drift |
| A-DX-4 | 0.2 | `ErrorResponse.hint`: one line of fix-it text for every code | Every code has a hint |
| A-ENG-1 | 1.1, 5.1 | J2534 DLLs load in a separate 32-bit bridge process (adopt `j2534-bridge`); ship an `i686-pc-windows-msvc` bridge build | Bridge round-trip test on Windows CI |
| A-ENG-4 | 1.2 | One `SafetyInterlock::check()` entry that every transport calls; no per-transport gating | Test fails if any transport sends a gated request without passing through it |
| A-CEO-4 | 1.2, 2.1 | Gated-command audit log: every gated attempt, allowed or refused, writes user, vehicle, ECU, service, outcome and NRC locally, then syncs to an `audit_log` table | One row per attempt |
| A-ENG-2 | 1.3 | Each profile's `did_maps` names its speed source. K-line is half-duplex with one ECU session at a time, so it reads speed from the target ECU, or re-initializes to the DME | Refuses with `PRECONDITION_UNKNOWN` on the virtual pre-03/2007 E90 when no fresh speed is available |
| A-ENG-9 | 1.3, 2.1 | Ring buffer capped (default 2 GB), evicting oldest synced rows and never unsynced ones; Timescale compression after 7 days, retention by tier | Cap and eviction test |
| A-CEO-2 | 2.2 | Idempotent sync: `batch_id` plus watermark; transactional outbox so a partial failure leaves the batch to retry | Duplicate and partial-failure tests |
| A-CEO-6 | 2.2, 4.1 | Case capture ships in Release 1: from the session overview the tech marks the actual fix, which feeds `cases/publish`. This is how the Phase 3 data gate fills | E2E: mark fix → anonymized case stored |
| A-ENG-5 | 2.1 | `FORCE ROW LEVEL SECURITY` on all tenant tables; app connects as a non-owner role; tenant set with `SET LOCAL` per transaction | One pooled connection reused across two tenants leaks nothing |
| A-CEO-3 | 2.3 | Stripe webhook signature verification and event-ID idempotency | Bad-signature and replay tests |
| A-ENG-6 | 3.1 | All Cypher goes through one repository module that adds the tenant filter; raw driver use elsewhere fails lint | Lint rule + cross-tenant test |
| A-ENG-8 | 3.2 | Upload limits 50 MB and 200 pages; per-page timeout; worker has no network and a memory cap | Oversized and malformed PDF tests |
| A-CEO-1 | 3.3 | LLM failure handling: malformed, empty, refused, timed-out and ungrounded-citation outputs each have their own path and fall back to case matches plus wiring with no AI summary. User text, DTC descriptions and PDF text are treated as untrusted data; output is schema-validated and may only cite node IDs from the subgraph | One test per failure class; quota not charged on fallback |
| A-ENG-7 | 3.3 | pgvector filtered search uses iterative index scans (confirm pgvector ≥ 0.8 in the image) or widens the filter in a second query | Returns 5 results when 5 eligible rows exist |
| A-DES-5 | 4.x | Produce `DESIGN.md` with gstack `/design-consultation` before Task 4.1 starts | DESIGN.md exists |
| A-DES-1 | 4.1 | Vehicle-session flow: Connect → Identify → Auto-scan all modules → Session overview (DTCs, tamper audit, alerts) → Live data, CAN studio or Copilot | Playwright walks the flow |
| A-DES-2 | 4.1–4.3 | Every screen has loading, empty, error, partial and success states, as listed in the review's state table | Playwright test per state |
| A-DES-3 | 4.1 | Safety confirm names the action, ECU and consequence, with a 1.5 s hold-to-confirm | Modal copy and hold tested |
| A-DES-6 | 4.x | Workshop baseline: 44 px touch targets, WCAG AA contrast, dark mode, severity shown by icon and text as well as color, fully keyboard operable | Axe check in Playwright |
| A-DES-7 | 4.2 | CAN studio supports 29-bit IDs | 29-bit capture fixture |
| A-DES-4 | 4.3 | Copilot cards show their evidence (case IDs, graph nodes) and a confidence band (high, medium or low) rather than a raw percentage | Cards render evidence links |
| A-ENG-10 | 5.1 | Hardware-in-the-loop release checklist: STN2120 on CAN, K+DCAN on a K-line ECU, one J2534 adapter through the bridge; one real-car capture per profile added as fixtures | Checklist signed off per release |
| A-CEO-5 | 5.2 | New task: observability and operations (below) | See Task 5.2 |

### Phase 0: Monorepo initialization and shared contracts

#### Task 0.1: Scaffold monorepo and local infrastructure

**Target paths**
- `Cargo.toml` (workspace root for the Rust edge daemon)
- `apps/edge-daemon/` (Rust crate)
- `apps/web/` (Next.js 15 App Router, TypeScript, Tailwind)
- `services/cloud-api/` (Python 3.12, FastAPI, Alembic)
- `services/ai-worker/` (Python Celery worker for schematic and ML pipelines)
- `packages/schemas/` (shared JSON Schema, OpenAPI, generated TypeScript and Rust types, `safety_policy.json`)
- `infra/docker-compose.yml`

**Implementation contract**
- `infra/docker-compose.yml` runs: postgres `timescale/timescaledb-ha:pg16` (TimescaleDB and pgvector); neo4j `neo4j:5-community` with APOC; redis `redis:7-alpine`; minio (S3-compatible, bucket `automotive-traces-au`).
- `.env.example` enforces `AWS_REGION=ap-southeast-2` and `DATA_RESIDENCY_ENFORCE=true`, and adds `LEASE_SIGNING_KEY_REF` (secret-manager reference, never a key in the repo), `LEASE_SIGNING_KID`, `VIN_HMAC_KEY_REF`, `EDGE_ALLOWED_ORIGINS` (production app origin, plus `http://localhost:3000` in dev only), `EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2`.

**Verification gate**
- `docker compose -f infra/docker-compose.yml up -d` brings postgres, neo4j, redis and minio to healthy. `SELECT extname FROM pg_extension;` shows `timescaledb` and `vector`.

#### Task 0.2: Canonical wire schemas and safety policy

**Target paths**
- `packages/schemas/edge_ws.schema.json`
- `packages/schemas/safety_policy.json`
- `apps/edge-daemon/src/protocol/messages.rs`
- `apps/web/src/types/edge-protocol.ts`

**Implementation contract: messages**

Tagged-union envelopes over `ws://127.0.0.1:8765`. Every request carries a client-generated `request_id`; every response or error echoes it.

| Message | Direction | Fields |
| --- | --- | --- |
| `HelloRequest` | web → daemon | `client_token` (cloud pairing JWT, or local pairing code from `edge-daemon pair`), `client_version` |
| `HelloResponse` | daemon → web | `session_id`, `daemon_version`, `lease_tier`, `features[]` |
| `AdapterListRequest` / `AdapterListResponse` | both | J2534 DLLs, SocketCAN interfaces, serial/FTDI/STN2120 ports, Flipper SLCAN |
| `ConnectRequest` | web → daemon | `adapter_id`, `protocol` (enum below), `baud_rate`, `safety_mode`: `SILENT` or `ACTIVE_CONFIRMED` |
| `DisconnectRequest` | web → daemon | `adapter_id` |
| `AdapterStatus` | daemon → web | `adapter_id`, `state`: `CONNECTED`/`DISCONNECTED`/`ERROR`, `battery_v` (nullable) |
| `CanFrameBatch` | daemon → web | `frames[]`: `timestamp_us`, `can_id`, `is_extended`, `dlc`, `data_hex` |
| `ObdPidStream` | daemon → web | `samples[]`: `timestamp_us`, `pid`, `name`, `value`, `unit` |
| `SafetyConfirmRequest` | web → daemon | `tx_id`, `rx_id`, `protocol`, `service_id`, `payload_hex`, `user_ack_text` |
| `SafetyConfirmResponse` | daemon → web | `safety_token`, `expires_at`, `preconditions`: `speed_kmh`, `speed_age_ms`, `rpm`, `battery_v` |
| `DiagCommandRequest` | web → daemon | `tx_id`, `rx_id`, `protocol`: `UDS`/`KWP2000`/`OBD`, `service_id`, `payload_hex`, `safety_token` (nullable) |
| `DiagCommandResponse` | daemon → web | `positive`, `response_hex`, `nrc` (nullable): `code`, `name` |
| `HeuristicAlert` | daemon → web | `rule_id`, `severity`: `INFO`/`AMBER`/`RED`, `title`, `evidence_json`, `recommended_test` |
| `ErrorResponse` | daemon → web | `code`: `UNAUTHENTICATED`, `ORIGIN_REJECTED`, `SAFETY_BLOCKED`, `TOKEN_INVALID`, `PRECONDITION_UNKNOWN`, `LEASE_REQUIRED`, `ADAPTER_ERROR`, `PROTOCOL_ERROR`, `TIMEOUT`; `message`, `detail_json` |

`ConnectRequest.protocol`: `AUTO`, `ISO15765_11_500`, `ISO15765_29_500`, `ISO15765_11_250`, `ISO15765_29_250`, `MS_CAN_125`, `BMW_DCAN`, `ISO14230_FAST`, `ISO14230_5BAUD`, `ISO9141_2`, `J1850_PWM`, `J1850_VPW`. J1850 is read-only OBD through STN/ELM adapters only.

**Implementation contract: safety policy**

`safety_policy.json` lists each gated request with a tier. Rust loads it with `include_str!`; the web app imports the same file.

| Protocol | Gated services | Tier |
| --- | --- | --- |
| UDS (ISO 14229-1) | 0x11 ECUReset, 0x14 ClearDiagnosticInformation, 0x27 SecurityAccess, 0x28 CommunicationControl, 0x29 Authentication, 0x2E WriteDataByIdentifier, 0x2F InputOutputControlByIdentifier, 0x31 RoutineControl, 0x85 ControlDTCSetting, 0x87 LinkControl | A |
| UDS (ISO 14229-1) | 0x10 sub-function 0x02 (programming session), 0x34, 0x35, 0x36, 0x37, 0x38 RequestFileTransfer, 0x3D WriteMemoryByAddress | B |
| KWP2000 (ISO 14230-3) | 0x11, 0x14, 0x27, 0x28 DisableNormalMessageTransmission, 0x2E WriteDataByCommonIdentifier, 0x2F IOControlByCommonIdentifier, 0x30 IOControlByLocalIdentifier, 0x31 StartRoutineByLocalIdentifier, 0x38 StartRoutineByAddress, 0x3B WriteDataByLocalIdentifier, 0x85 ControlDTCSetting | A |
| KWP2000 (ISO 14230-3) | 0x10 sub-function 0x85 (programming session), 0x34, 0x35, 0x36, 0x37, 0x3D | B |
| OBD-II (SAE J1979) | Mode 0x04 clear DTCs, Mode 0x08 control of on-board system | A |

- Tier A: valid `safety_token` and vehicle speed 0 km/h from PID 0x0D read within the last 2 s.
- Tier B: Tier A plus RPM 0 and battery voltage ≥ 12.5 V.
- Bench mode may replace the speed check only; it needs its own confirmation, is logged, and lasts until disconnect.
- UDS 0x10 sub-function 0x03 (extended session) stays ungated because many read-only identifiers need it; each use is logged.

**Verification gate**
- Rust `serde_json` fixtures for every message deserialize against the TypeScript Zod validators, and vice versa.
- Every request type has a response type and can return `ErrorResponse`.
- Rust and TypeScript load `safety_policy.json` and a test asserts both see the same gated set.

### Phase 1: Rust edge daemon (hardware, protocols, safety)

#### Task 1.1: Hardware abstraction layer and virtual vehicles

**Target paths**
- `apps/edge-daemon/Cargo.toml`: tokio, tokio-tungstenite, serde, serde_json, rusqlite, thiserror, tracing, serialport, ed25519-dalek, jsonwebtoken; `j2534` on Windows; `socketcan`, `socketcan-isotp` on Linux
- `apps/edge-daemon/src/hal/{mod,virtual_bus,virtual_kline,slcan_serial,stn_elm,kline_ftdi,j2534_win,socketcan_linux}.rs`
- `apps/edge-daemon/src/sim/profiles/` (one file per vehicle profile)

**Implementation contract**
- Two async traits: `VehicleBusAdapter` (CAN: `open`, `set_filter`, `send_frame`, `recv_frame`, `close`) and `KLineAdapter` (`open`, `wake_fast_init`, `wake_5baud(addr)`, `write_bytes`, `read_bytes(timeout)`, `close`).
- `DiagTransport` (request bytes in, response bytes out) sits above both; Task 1.2 implements ISO-TP over CAN, ISO 14230-2 over K-line, and ELM-framed for STN/ELM.
- `SlcanSerialAdapter`: Flipper Zero USB-UART / MCP2515 SLCAN `O`, `C`, `S6`, `t...`, `T...`.
- `StnElmAdapter`: detects STN1110/STN2120 via `STI`; `ATSP0`, `ATH1`, `ATCAF0`; K-line (`ATSP3/4/5`, `ATSH`, `ATWM`); J1850 (`ATSP1/2`, read-only). MS-CAN switching via STN protocol commands; verify `STP` numbers against the STN reference before coding.
- `KLineFtdiAdapter`: K+DCAN cables in K-line mode; raw FTDI serial at 10,400 baud; fast init 25 ms low / 25 ms high then StartCommunication (0x81). D-CAN-mode use of these cables is out of scope.
- Virtual profiles reply with realistic timing, NRCs and SecurityAccess seed/key with time-delay lockout:

| Profile | Modules | Transport | Services |
| --- | --- | --- | --- |
| BMW E90, built before 03/2007 | DME, CAS, DSC | K-line ISO 14230, 10.4 kbit/s, fast init | KWP2000, BMW variant |
| BMW E90, built 03/2007 on | DME, CAS, DSC | BMW D-CAN 500 kbit/s; tester 0x6F1 + target byte; ECU replies 0x600 + address | KWP2000-style over ISO-TP, extended addressing |
| Ford Falcon BA (2002–2005) | PCM, IC, ABS | HS-CAN 500 kbit/s, 11-bit, ISO 15765-4 | OBD modes 0x01–0x0A; Ford enhanced reads via 0x22 |
| Generic UDS ECU (2010+) | Engine ECU | ISO 15765-4, 500 kbit/s, 11-bit | Full UDS set from Task 1.2 |

**Verification gate**
- `cargo test --package edge-daemon hal::` passes CAN round-trip on `VirtualBusAdapter` and K-line fast-init/byte round-trip on `VirtualKLineAdapter`.
- Recorded SLCAN and STN2120 byte streams parse, including STN K-line responses.

#### Task 1.2: Transports, diagnostic clients and safety interlock

**Target paths**
- `apps/edge-daemon/src/protocols/{isotp,addressing,kline,uds,kwp2000,obd}.rs`
- `apps/edge-daemon/src/safety/{policy,interlock}.rs`

**Implementation contract**
- ISO 15765-2 SF/FF/CF/FC honoring BlockSize and STmin, normal and BMW extended addressing.
- ISO 14230-2 headers, length byte, checksum, P1–P4 timing, fast and 5-baud init.
- UDS helpers: 0x10, 0x19, 0x22, 0x27, 0x2F, 0x31, 0x3E. KWP2000 helpers: 0x10, 0x18, 0x1A, 0x21, 0x22, 0x27, 0x30, 0x31, 0x3E.
- `SafetyInterlock` checks every outgoing request against `safety_policy.json`:
  - `SILENT`: every gated request refused with `SAFETY_BLOCKED`.
  - `ACTIVE_CONFIRMED`: gated request needs a single-use `safety_token`, 60 s expiry, bound to `session_id`, `tx_id`, `rx_id`, `protocol`, `service_id`, SHA-256 of `payload_hex`.
  - Tier preconditions read live; unknown or stale → `PRECONDITION_UNKNOWN`.
  - NRC 0x78 extends to P2* (5,000 ms default), not a failure.
  - One NRC 0x35 halts SecurityAccess to that ECU for the session; NRC 0x36/0x37 halt and report the delay.

**Verification gate**
- ISO-TP reassembles > 64 bytes with BlockSize/STmin honored.
- KWP2000 fast init + 0x1A read on virtual pre-03/2007 E90 DME; BMW D-CAN extended-addressing round trip on virtual 03/2007+ E90 DME.
- Table-driven test: every service in `safety_policy.json` refused in `SILENT`.
- Expired, reused, mismatched tokens refused; unknown or > 2 s old speed refused.
- SecurityAccess halted after NRC 0x35 and after 0x36/0x37; NRC 0x78 then positive succeeds.

#### Task 1.3: Edge heuristics and local SQLite ring buffer

**Target paths**
- `apps/edge-daemon/src/analytics/{heuristics,can_re}.rs`, `analytics/did_maps/` (per-profile VIN/odometer identifiers)
- `apps/edge-daemon/src/storage/ring_buffer.rs`

**Implementation contract**
- Fuel-trim matrix: STFT + LTFT at idle vs 2,500 RPM. > +12% at idle normalizing under load → vacuum/intake leak; elevated at both → fuel pressure/MAF bias. AMBER.
- Cold-soak divergence: |ECT − IAT| > 6 °C at key-on, RPM 0. AMBER; evidence notes sun/heat-soak false positives.
- Cross-module audit using the profile's `did_maps`: VIN/odometer mismatch → RED; PID 0x31 < 50 km or incomplete monitors → AMBER "Codes recently cleared"; no mapping → INFO "not supported for this vehicle".
- CAN RE: per-bit flip counters Bᵢ per arbitration ID; Mᵢ = log₁₀(Bᵢ); ByCAN θᶜₘₙ = bᶜₘₙ × uᶜₘₙ; classify static, counter, CRC, boolean, continuous.
- SQLite WAL buffer persists `CanFrameBatch` and `ObdPidStream` with sync watermarks.

**Verification gate**
- Fixtures produce exact `HeuristicAlert`s for vacuum leak, odometer mismatch, recently cleared ECU, unsupported vehicle.
- Simulated window-switch toggle log yields expected bitfield classes.

#### Task 1.4: Secured local WebSocket server and offline lease verifier

**Target paths**
- `apps/edge-daemon/src/server/{ws,pairing}.rs`, `src/auth/{lease,cloud_keys}.rs`, `src/main.rs`

**Implementation contract**
- Bind 127.0.0.1:8765 and [::1]:8765 only.
- On upgrade: reject `Host` other than `127.0.0.1:8765`, `localhost:8765`, `[::1]:8765`; reject browser `Origin` not in `EDGE_ALLOWED_ORIGINS`; no-`Origin` native clients only with a local pairing code.
- First message must be `HelloRequest` within 5 s; anything else → `UNAUTHENTICATED` and close.
- `client_token`: cloud pairing JWT (`aud=edge-ws`, matching `origin`, ≤ 5 min), or 6-digit `edge-daemon pair` code (single-use, 2 min).
- 1 MiB message limit; 20 `DiagCommandRequest`/s per connection.
- Leases: Ed25519 JWTs verified with the cloud public key chosen by `kid` from `cloud_keys.rs`; check `aud=edge-daemon`, `exp`, `nbf`, `tenant_id`, 5 min skew. Unlocks `J2534`, `UDS_ACTIVE`, `CAN_RE_PRO` offline up to 72 h.

**Verification gate**
- Pair a test client, list adapters, connect to `VirtualBusAdapter`, receive `ObdPidStream` and `CanFrameBatch` at ≥ 20 Hz.
- Rejected: disallowed `Origin`, wrong `Host`, no Hello in 5 s, `DiagCommandRequest` before Hello, reused pairing code, lease signed by an unknown key, expired lease.

### Phase 2: Sovereign cloud backend (FastAPI, multi-tenant DB, billing)

#### Task 2.1: Multi-tenant PostgreSQL schema with RLS

**Target paths**: `services/cloud-api/app/db/models.py`, `services/cloud-api/alembic/versions/001_init_multi_tenant_rls.py`

**Implementation contract**
- Tables: `tenants`, `users`, `tenant_memberships` (`OWNER`/`LEAD_TECH`/`TECH`), `vehicles`, `diagnostic_sessions`, `telemetry_samples` (hypertable), `resolved_cases`, `custom_dbc_files`, `wiring_schematics`.
- `vehicles`: `vin_hmac` (HMAC-SHA256, key from `VIN_HMAC_KEY_REF`), `wmi_vds`, `make`, `model`, `year`.
- `resolved_cases`: `embedding vector(384)` + HNSW (cosine), `embedding_model text`, `feature_vector real[]`.
- RLS on every tenant-owned table using `current_setting('app.current_tenant_id')::uuid`.

**Verification gate**: Tenant A vehicle invisible when session is set to Tenant B.

#### Task 2.2: Control plane, lease and pairing issuer, session sync

**Target paths**: `services/cloud-api/app/{main.py, api/v1/auth.py, api/v1/sessions.py, api/v1/dbc.py, services/anonymizer.py, services/signing.py}`

**Implementation contract**
- `signing.py`: Ed25519 key from secret manager, `kid` in every JWT header; public key + `kid` exported at build time into `cloud_keys.rs`.
- `POST /api/v1/auth/edge-lease`: 72 h JWT, `aud=edge-daemon`, `tenant_id`, `tier`, `aasra_verified`, feature flags.
- `POST /api/v1/auth/edge-pairing`: 5 min JWT, `aud=edge-ws`, `user_id`, `tenant_id`, requesting `origin`.
- `POST /api/v1/sessions/sync`: compressed telemetry/DTC batches → TimescaleDB; raw CAN traces → MinIO/S3 ap-southeast-2.
- `POST /api/v1/cases/publish`: strip PII, workshop IDs, VIN positions 10–17; keep `wmi_vds`, DTCs, feature vector, canonical summary.

**Verification gate**
- Lease and pairing tokens from `signing.py` verify in the Rust daemon with the pinned key (shared fixture); other keys or wrong `aud` rejected.
- Batch ingestion stores expected rows/objects; anonymizer removes VIN serials and names.

#### Task 2.3: Subscription metering and Australian gateway compliance hooks

**Target paths**: `services/cloud-api/app/api/v1/{billing,gateways}.py`

**Implementation contract**
- Stripe webhook updates `tenants.subscription_tier` (`COMMUNITY`/`PRO`/`WORKSHOP`) and monthly quotas (`ai_diagnoses_used`, `schematic_pages_used`).
- `/api/v1/gateways/aasra-verify`, `/api/v1/gateways/autoauth-token` with MVIS VSP audit logging.

**Verification gate**: simulated `checkout.session.completed` and `invoice.paid`; HTTP 402 past free-tier limits.

### Phase 3: AI and hybrid schematic-to-graph pipeline

#### Task 3.1: Neo4j electrical topology schema and seed loader

**Target paths**: `services/ai-worker/app/graph/{neo4j_client,seed_topologies}.py`

**Implementation contract**
- Labels `:ECU`, `:Connector`, `:Pin`, `:Wire`, `:Splice`, `:GroundPoint`, `:Fuse`, `:Sensor`, `:Actuator`; relationships `:CONNECTED_TO`, `:POWERED_BY`, `:GROUNDED_AT`, `:ON_BUS`.
- Seed topologies tagged by `tenant_id` or `global`; every query filters caller tenant + `global`.

**Verification gate**: 2-hop Cypher finds shared `:GroundPoint`/`:Fuse` and exact path; another tenant cannot see the nodes.

#### Task 3.2: Vector-first PDF schematic ingestion

**Target paths**: `services/ai-worker/app/vision/{schematic_pipeline,vector_extract,raster_extract}.py`, `services/ai-worker/app/tasks/ingest_schematic.py`

**Implementation contract**
- Per-page classification. Vector path: PyMuPDF `get_drawings()` + `get_text("dict")`, merge collinear segments, find junctions/splices, snap to pin labels/component boxes. Raster path (scanned pages only): 300 DPI, PaddleOCR/Tesseract, OpenCV morphology + `HoughLinesP`, snap.
- Both emit the same intermediate graph JSON → tenant Neo4j subgraph; each edge records source path and confidence.

**Verification gate**: synthetic vector PDF (3 components, 4 pins) gives expected graph; rasterized copy gives the same graph.

#### Task 3.3: KG-guided RAG root-cause localizer

**Target paths**: `services/cloud-api/app/services/{ai_diagnostic_agent,embeddings}.py`, `services/cloud-api/app/api/v1/diagnose.py`

**Implementation contract**
1. Canonical text summary → `EMBEDDING_MODEL` (384-dim), self-hosted ap-southeast-2; numeric `feature_vector` built separately.
2. pgvector top 5 by cosine, filtered by `wmi_vds`/engine family and matching `embedding_model`, re-ranked on `feature_vector`.
3. Neo4j 1–2 hop shared power/ground/CAN dependencies across modules with active DTCs.
4. LLM synthesis with ap-southeast-2 routing and JSON structured output: ranked causes, confidence, shared circuit, multimeter tests.

**Verification gate**: `POST /api/v1/diagnose/{session_id}` on DME + DSC + EGS dump returns structured JSON citing the shared node; no embedding request leaves the region.

### Phase 4: Next.js SaaS frontend

#### Task 4.1: Edge client, pairing and live dashboard

**Target paths**: `apps/web/src/lib/edge-client.ts`, `apps/web/src/store/diagnostic-store.ts`, `apps/web/src/app/(dashboard)/live/page.tsx`, `apps/web/src/components/edge/ConnectionStatus.tsx`, `apps/web/src/components/safety/SafetyConfirmModal.tsx`

**Implementation contract**
- Auto-reconnecting client with Zustand; fetches pairing JWT and sends `HelloRequest` first on every connect.
- `ConnectionStatus`: daemon not running / browser blocked local connection / pairing rejected / connected, each with fix-it text.
- Safety badge; `SafetyConfirmModal` shows live preconditions before confirm; gated buttons labeled from `safety_policy.json`.
- Canvas/WebGL oscilloscope (RPM, MAF, STFT/LTFT B1/B2, ECT, IAT); heuristic alert banner; plain-words refusals and NRCs.

**Verification gate**: Playwright pairs with daemon on `VirtualBusAdapter`, live PIDs render with no console errors; modal blocks until confirmed; unknown speed shows `PRECONDITION_UNKNOWN`; killed daemon shows "not running".

#### Task 4.2: CAN reverse-engineering studio

**Target paths**: `apps/web/src/app/(dashboard)/can-studio/page.tsx`, `apps/web/src/components/can/BitFlipMatrix.tsx`

**Implementation contract**: SavvyCAN-style 64-bit matrix per ID 0x000–0x7FF colored by Mᵢ and ByCAN class; "Record baseline vs action" isolates changed bitfields and exports `.dbc` or saves to cloud.

**Verification gate**: Playwright baseline-vs-toggle capture isolates the bitfield and downloads a valid `.dbc`.

#### Task 4.3: AI root-cause copilot and wiring graph explorer

**Target paths**: `apps/web/src/app/(dashboard)/copilot/[sessionId]/page.tsx`, `apps/web/src/components/graph/WiringTopologyViewer.tsx`

**Implementation contract**: react-flow or cytoscape subgraph with failing ECUs, shared fuses/grounds highlighted; ranked cause cards, multimeter checklist, PDF upload dropzone.

**Verification gate**: Playwright loads seeded multi-DTC session, triggers analysis, graph and ranked steps render.

### Phase 5: Packaging, CI/CD and production hardening

#### Task 5.1: Native daemon service installers and CI

Headless background service; a tray app would be its own task.

**Target paths**: `.github/workflows/ci.yml`, `apps/edge-daemon/packaging/windows/` (.msi), `apps/edge-daemon/packaging/linux/` (systemd, `99-automotive-vci.rules`), `scripts/export_cloud_keys.py`

**Implementation contract**
- CI on every PR: `cargo test` (incl. safety and WS security tests), `pytest` with postgres + neo4j containers, `next build` + Playwright, cross-language schema/policy/JWT fixture tests.
- udev rules for `/dev/ttyUSB*`, `/dev/ttyACM*` (Flipper Zero, OBDLink EX, FTDI K+DCAN).
- Installer binds loopback only and writes production `EDGE_ALLOWED_ORIGINS`.
- Code signing: Authenticode for Windows .msi and executable; detached signature for Linux.

**Verification gate**: CI green across Rust, Python, TypeScript; release builds for `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu`; post-install smoke test confirms loopback-only listen and refusal of unpaired connections.

#### Task 5.2: Observability and operations (A-CEO-5)

**Target paths**: `apps/edge-daemon/src/telemetry/`, `services/cloud-api/app/observability/`, `infra/monitoring/`, `docs/runbooks/`

**Implementation contract**
- Daemon: structured `tracing` logs to a rotating local file; `edge-daemon diagnostics` exports a redacted support bundle (logs, versions, adapter list, last 100 gated-command audit rows).
- Cloud: structured JSON logs with request and trace IDs carried from web → API → worker; metrics for sync lag, diagnose latency and fallback rate, webhook failures, ingest failures, and active daemons by version.
- Alerts: webhook signature-failure bursts, sync backlog, diagnose fallback rate, ingest failure rate, error budget on the API.
- Runbooks in `docs/runbooks/` for each alert, plus signing-key rotation and daemon rollback.
- Deployment target recorded in `docs/architecture.md` (AWS ap-southeast-2).

**Verification gate**: each alert fires in a staging drill and links to its runbook; a support bundle contains no VIN serials, tokens or keys.

## Review record

gstack `/autoplan` ran on 2026-11-19 (CEO, design, DX, engineering). Full record: `docs/reviews/2026-11-19-autoplan-review.md`. Accepted amendments are in the table under the operating rules. Gate result (2026-11-19): uc1 approved; uc2 and uc3 declined.
