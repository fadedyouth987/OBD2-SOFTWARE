# Module discovery and the module catalogue

How RootCause finds every module on a vehicle, and how to add or correct modules.

## How a scan finds modules

A hand-written module list per vehicle is always incomplete: the registry used to list 4–6 modules for a Ranger PX3, which has 25. So a scan of a real vehicle **finds** modules instead (the same approach as FORScan and comma.ai's opendbc):

1. **Plan** (`apps/web/src/lib/module-discovery.ts`, `buildPlan`):
   - the vehicle's registry modules on the network the adapter is connected to;
   - its make family's named modules from `packages/schemas/module_catalog.json`;
   - the family's **sweeps**: every address in its range (e.g. 11-bit 0x700–0x7F7, GM 0x240–0x27F with replies +0x400, 29-bit 0x18DA00F1–0x18DAFFF1, BMW extended 0x00–0xFF).

   Registry modules on another network (MS-CAN, Ford's second HS-CAN, J1850, ALDL…) aren't probed. They're reported as **Other network**, with what it takes to reach them, never as "didn't respond".
2. **Probe** (`discover`): TesterPresent (`3E 00`, or `3E 01` for KWP2000) to each address. Any reply, positive or negative, means a module is there. TesterPresent is read-only and not in `safety_policy.json`'s gated set. Probes are paced under the daemon's 20 requests/s limit; a full 11-bit plus 29-bit sweep takes about 30 s, and the technician can stop it.
3. **Read codes** (`scan.ts` `scanModule`) from each module that answered: OBD modes 03/07/0A on the engine, UDS 19 02, and KWP2000 18 when a module answers UDS with "service not supported".

Found modules are named from the registry, then the catalogue; anything else shows as "Module at 0x7A5" (found by address search), so nothing that answers is hidden.

Simulated vehicles (daemon `virtual-*` adapters and the browser demo car) scan their fixed module list, so tests stay fast and deterministic.

### Daemon side

- CAN ids above 0x7FF open 29-bit channels (`CanAddressing::normal`).
- ELM327/STN adapters can only send the id width they're connected in. A 29-bit probe on an 11-bit connection returns an adapter error, and discovery skips the rest of that width with a note telling the technician to reconnect in 29-bit mode.
- Each channel receives every bus frame, so the daemon keeps at most `MAX_DIAG_CHANNELS` (32) open per connection and closes the least recently used.
- `tests/ws_gate.rs::tester_present_sweep_finds_exactly_the_simulated_modules` sweeps the virtual Falcon through the real server: IC, ABS and PCM answer, nothing else.

## What discovery can't reach yet

| Gap | Affects | What it needs |
| --- | --- | --- |
| Ford second HS-CAN on OBD pins 3/11 (500k) | Ranger PX3 ABS, RCM, PSCM, SCCM, IPMA, OCSM, HUD, ATCM | A bus protocol for pins 3/11 at 500k (STN `STP` number to verify, see status.md) |
| Toyota sub-addressing (0x750 + address byte) | Toyota body ECUs, camera, radar | ISO 15765 extended addressing in the daemon and a sub-address field on `DiagCommandRequest` |
| GM single-wire CAN (pin 1, 33.3k) | Older GM/Holden body modules | Hardware and protocol support |
| VW group 29-bit ids outside the ISO range | Newest VW group models | A sweep for their id scheme |
| J1850, K-line, ALDL modules other than the engine's emissions codes | Older Falcon, Commodore, BMW | Per-protocol module addressing |

## Adding or correcting modules

- **Catalogue** (`packages/schemas/module_catalog.json`): one entry per module per make family, with `abbr`, `name`, `tx`, `rx`, and a `source` key from `sources`. Use a workshop manual, opendbc, or a capture from a real car. If none exists, use source `registry_unverified` and say so in `note`. Names follow the maker's own abbreviations (FORScan's list for Ford and Mazda).
- **Registry** (`services/cloud-api/app/services/vehicle_registry.py`): modules known to be on a specific platform, each with its `network`. Non-CAN modules have empty `tx`/`rx`, so nothing ever sends CAN to them. Platforms that share a maker code (WMI) set `years` so VIN decoding picks the right generation.
- Tests: `apps/web/tests/module-discovery.test.ts` (schema, sweeps, plan, discovery) and `services/cloud-api/tests/test_module_catalog.py` (every platform has a family, valid networks, the corrections and VIN year decoding).
- As with every vehicle fixture (A-ENG-10), an entry is confirmed when a scan of a real car finds it at that address.
