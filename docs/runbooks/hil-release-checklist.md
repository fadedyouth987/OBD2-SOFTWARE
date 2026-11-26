# Hardware-in-the-loop release checklist (A-ENG-10)

Every automated gate runs against simulators written alongside the clients, so a shared misunderstanding of a protocol can pass every test. Before **each release** of the edge daemon, a technician runs this checklist on the bench with real adapters and real ECUs. A release ships only when every row is ticked, or a row is explicitly waived in the release notes with the reason.

Record the result in the release PR: copy the tables below, fill in the date, who ran it, the daemon version and the adapter serials.

## Bench

| Item | Used for |
| --- | --- |
| STN2120-based adapter (OBDLink EX/MX+ or equivalent) | CAN, K-line and J1850 through STN/ELM |
| K+DCAN cable (FTDI) | K-line fast and 5-baud init |
| One J2534 PassThru device with its 32-bit vendor DLL, on Windows | J2534 through `j2534-bridge` (A-ENG-1) |
| Bench ECU on CAN (any 500 kbit/s UDS ECU) | ISO-TP, UDS, gated services |
| Bench K-line ECU (pre-03/2007 BMW E90 DME or equivalent) | KWP2000, the K-line speed source (A-ENG-2) |
| 12 V bench supply with adjustable voltage | Tier B battery precondition |
| A real vehicle for each supported profile (see below) | Real-car captures |

## 1. Adapters

| # | Check | How | Pass when |
| --- | --- | --- | --- |
| 1.1 | STN2120 detected and identified | Devices page → adapter list | Shows as STN2120 with firmware version |
| 1.2 | STN2120 on CAN | Connect to the CAN bench ECU, read the VIN and stored codes | Same VIN and codes as the ECU's own tool |
| 1.3 | STN2120 on K-line | Connect to the K-line ECU | Identification read; the `ATSH 80 12 F1` length-bit assumption holds (open item from Task 1.1) |
| 1.4 | K+DCAN fast init | `KLineFtdiAdapter` fast init to the K-line ECU | StartCommunication positive response |
| 1.5 | K+DCAN 5-baud init | Same, 5-baud address | Key bytes read and acknowledged |
| 1.6 | J2534 via the 32-bit bridge | `J2534_TEST_DLL=C:\path\driver.dll cargo test -p j2534-bridge -- --ignored` | `real_device_round_trip` passes |
| 1.7 | SocketCAN (Linux) | `cargo test -p edge-daemon -- --ignored socketcan` on a real `can0` | Passes |
| 1.8 | MS-CAN on STN | Only once the `STP` numbers are verified against the STN reference | Still returns `Unsupported` until then; record which |

## 2. Safety interlock on real hardware

| # | Check | Pass when |
| --- | --- | --- |
| 2.1 | Every gated service is refused in `SILENT` on each adapter | No frame reaches the bus (watch with a second CAN interface) |
| 2.2 | Tier A refuses while the vehicle speed reading is older than 2 s | `PRECONDITION_UNKNOWN`; the web safety screen also blocks the hold |
| 2.3 | Tier B refuses at 12.4 V and allows at 12.6 V (bench supply) | Refusal names the battery; allowed after the hold |
| 2.4 | K-line speed source on the pre-03/2007 DME | Speed read from the target ECU or re-init to the DME; otherwise `PRECONDITION_UNKNOWN` |
| 2.5 | Hold-to-confirm cancels when a check fails mid-hold | Start the hold, then raise RPM above 0 (or unplug the speed source): the hold stops and nothing is sent |
| 2.6 | Every attempt is in the audit log | One row per attempt, allowed or refused, with ECU, service, outcome and NRC; it syncs to the cloud `audit_log` |
| 2.7 | Unplug the adapter mid-command | `AdapterStatus: ERROR`; the web says the outcome is unknown, never "done" |

## 3. Live data and CAN Studio

| # | Check | Pass when |
| --- | --- | --- |
| 3.1 | Live PIDs at 20 Hz or more on the CAN ECU | Live data shows steady updates |
| 3.2 | Stalled stream | Pull the adapter's vehicle side: "Live data has stopped" appears within about 2 s |
| 3.3 | CAN Studio with 11-bit and 29-bit IDs | Both kinds appear; 29-bit IDs render as 8 hex digits |

## 4. Real-car captures (fixtures)

For each supported profile, capture one session from a real car and add it to `apps/edge-daemon/fixtures/hal/` (replacing the hand-built stream where one exists), then confirm the parser tests still pass.

| Profile | Vehicle | Capture file | Done |
| --- | --- | --- | --- |
| `generic_uds` | Any 2010+ ISO 15765 vehicle | | |
| `e90_dcan` | BMW E90, 03/2007 or later | | |
| `e90_pre2007` | BMW E90, before 03/2007 (K-line) | | |
| `falcon_ba` | Ford Falcon BA | | |

Strip the VIN serial (last 6 characters) and anything identifying the owner before committing a capture.

## 5. Install and update

| # | Check | Pass when |
| --- | --- | --- |
| 5.1 | Windows .msi and Linux package install | Service starts on boot, listens on 127.0.0.1 only |
| 5.2 | Unpaired connection | Refused until paired |
| 5.3 | Version skew | An older web build against this daemon (and the reverse) shows the update banner, never silent failure |
| 5.4 | Rollback | Reinstalling the previous version works; see [daemon-rollback.md](daemon-rollback.md) |
| 5.5 | Support bundle | `edge-daemon diagnostics` writes a bundle with no VIN serials, tokens or keys |

## Sign-off

| Release | Daemon version | Date | Run by | Waived rows (with reason) |
| --- | --- | --- | --- | --- |
| | | | | |
