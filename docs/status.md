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

Deviations from the Task 1.1 target paths, on purpose:

- `tokio-tungstenite`, `rusqlite` and `ed25519-dalek` were added by the tasks that use them (1.3, 1.4), not in 1.1, so no unused dependencies ship; `jsonwebtoken` was replaced (see Task 1.4).
- The Windows `j2534` dependency lives in `apps/j2534-bridge` (as the maintained fork `j2534-mrw`; `j2534` 0.3.1 no longer compiles), because A-ENG-1 moves DLL loading out of the daemon. `hal/j2534_win.rs` is the daemon's bridge client and builds on every OS.
- `serialport` is built without libudev, so the daemon needs no system packages; USB details for discovery may be missing on Linux.
