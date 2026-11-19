# Build status

Progress through [`PLAN.md`](PLAN.md), in Rule 1 order. A task is done when its Verification Gate and review amendments pass; anything not verified is listed here, not hidden.

| Task | Status | Evidence |
| --- | --- | --- |
| 0.1 Scaffold and local infrastructure | Done, except the infra gate | `just lint`, `just test`, web build pass. **Deferred:** `just infra-gate` has not run anywhere (no Docker in the agent sandbox; GitHub Actions is not starting jobs on this account). Must pass before Task 2.1. |
| 0.2 Wire schemas and safety policy | Done | 52 parity tests (Rust + vitest), `just codegen-check` drift gate. |
| 1.1 HAL and virtual vehicles | Done, with hardware items open | See below. |
| 1.2 Transports, clients, safety interlock | Done | See below. |

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

Deviations from the Task 1.1 target paths, on purpose:

- `tokio-tungstenite`, `rusqlite`, `ed25519-dalek` and `jsonwebtoken` are added by the tasks that use them (1.3, 1.4), not in 1.1, so no unused dependencies ship.
- The Windows `j2534` dependency lives in `apps/j2534-bridge` (as the maintained fork `j2534-mrw`; `j2534` 0.3.1 no longer compiles), because A-ENG-1 moves DLL loading out of the daemon. `hal/j2534_win.rs` is the daemon's bridge client and builds on every OS.
- `serialport` is built without libudev, so the daemon needs no system packages; USB details for discovery may be missing on Linux.
