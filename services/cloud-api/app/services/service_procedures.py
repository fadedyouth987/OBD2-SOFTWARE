"""Service-function procedures (oil reset, SAS calibration, DPF regen, ...).

The catalogue (``SERVICE_FUNCTIONS_CATALOG``) says what each function is. A
*procedure* says exactly which request goes to which module. Real procedures
are OEM data: routine and I/O identifiers differ per make, model and software
level, and we do not have a licensed source for them yet. So the only
procedures built in are for the edge daemon's virtual vehicles, where the
identifiers are the simulator's own and are labelled as such. Real vehicles get
procedures only from a licensed source imported into ``procedure_records``
(``app.services.procedures``); every other vehicle gets an honest "no verified
procedure on file" instead of a guess.

No procedure uses SecurityAccess (0x27) or any seed/key exchange: each runs
in the extended diagnostic session, and every gated request still needs the
daemon's safety token (safety_policy.json).
"""

from __future__ import annotations

from typing import Any

from app.services.vehicle_registry import SERVICE_FUNCTIONS_CATALOG

# Technician checklist shown before the safety confirmation. These are the
# workshop conditions for the job; the daemon separately enforces the speed /
# RPM / battery interlock for the request's policy tier.
CHECKLISTS: dict[str, list[str]] = {
    "oil_reset": [
        "Oil and filter have been changed",
        "Ignition on, engine off",
    ],
    "bms_reset": [
        "New battery is fitted and terminals are tight",
        "Battery type and capacity match the replacement label",
        "Ignition on, engine off",
    ],
    "epb_service": [
        "Vehicle is on level ground with wheels chocked",
        "Ignition on, engine off, transmission in Park",
        "Nobody is working near the rear calipers while they move",
    ],
    "sas_cal": [
        "Wheels are pointing straight ahead",
        "Wheel alignment is within specification",
        "Engine running or ignition on, vehicle stationary",
    ],
    "dpf_regen": [
        "Vehicle is outdoors, clear of anything flammable, exhaust unobstructed",
        "Transmission in Park or Neutral, park brake on",
        "Coolant at least 70 °C and fuel above a quarter tank",
        "Battery at least 12.5 V or a charger connected",
    ],
    "abs_bleed": [
        "Brake fluid reservoir is full and a bleed kit is fitted",
        "A second person is ready at the bleed nipples",
        "Ignition on, engine off",
    ],
    "injector_coding": [
        "Injector trim codes have been read from the new injectors",
        "Battery charger connected",
    ],
    "throttle_relearn": [
        "Throttle body is clean and the connector is plugged in",
        "Ignition on, engine off, accelerator pedal released",
    ],
    "tpms_relearn": [
        "All four tyre pressures are set to the placard value",
        "TPMS activation tool is to hand",
    ],
    "radar_cal": [
        "Vehicle is on flat, level ground with clear space around the sensors",
        "Sensors and bumper covers are clean and undamaged",
    ],
    "ckp_relearn": [
        "Engine at operating temperature",
        "Transmission in Park or Neutral, park brake on",
    ],
}


def _routine(
    module: str, tx: int, rx: int, rid: int, *, seconds: int, stoppable: bool = False
) -> dict[str, Any]:
    rid_hex = f"{rid:04X}"
    return {
        "module": module,
        "tx_id": tx,
        "rx_id": rx,
        "service": "RoutineControl",
        "identifier": f"0x{rid_hex}",
        "enter_session_hex": "1003",
        "start_hex": f"3101{rid_hex}",
        "stop_hex": f"3102{rid_hex}" if stoppable else None,
        "stop_needs_confirmation": stoppable,
        "exit_session_hex": "1001",
        "expected_seconds": seconds,
    }


def _io_control(module: str, tx: int, rx: int, did: int, *, seconds: int) -> dict[str, Any]:
    did_hex = f"{did:04X}"
    return {
        "module": module,
        "tx_id": tx,
        "rx_id": rx,
        "service": "InputOutputControlByIdentifier",
        "identifier": f"0x{did_hex}",
        "enter_session_hex": "1003",
        # shortTermAdjustment, state 1 (run).
        "start_hex": f"2F{did_hex}0301",
        # Leaving the extended session hands every I/O control back to the ECU
        # (ISO 14229-1), so stopping needs no second gated request.
        "stop_hex": "1001",
        "stop_needs_confirmation": False,
        "exit_session_hex": "1001",
        "expected_seconds": seconds,
    }


# Keyed by the daemon's virtual profile id (adapter id "virtual-<profile>").
# The identifiers are the simulator's, not any manufacturer's.
SIMULATOR_PROCEDURES: dict[str, dict[str, dict[str, Any]]] = {
    "ford-falcon-ba": {
        "throttle_relearn": _routine("PCM", 0x7E0, 0x7E8, 0x0401, seconds=5),
        "ckp_relearn": _routine("PCM", 0x7E0, 0x7E8, 0x0403, seconds=5),
        "oil_reset": _routine("IC", 0x720, 0x728, 0x0501, seconds=2),
        "sas_cal": _routine("ABS", 0x760, 0x768, 0x0602, seconds=3),
        "abs_bleed": _io_control("ABS", 0x760, 0x768, 0x4B01, seconds=30),
    },
    "generic-uds": {
        "throttle_relearn": _routine("ENGINE", 0x7E0, 0x7E8, 0x0401, seconds=5),
        "dpf_regen": _routine("ENGINE", 0x7E0, 0x7E8, 0x0402, seconds=60, stoppable=True),
        "ckp_relearn": _routine("ENGINE", 0x7E0, 0x7E8, 0x0403, seconds=5),
        "bms_reset": _routine("ENGINE", 0x7E0, 0x7E8, 0x0404, seconds=2),
    },
}

VIRTUAL_PREFIX = "virtual-"


def simulator_profile(adapter_id: str | None) -> str | None:
    if adapter_id and adapter_id.startswith(VIRTUAL_PREFIX):
        return adapter_id[len(VIRTUAL_PREFIX) :]
    return None


def service_functions_for(adapter_id: str | None, vehicle=None) -> dict[str, Any]:
    """The 11 functions, each with its checklist and a procedure when one is on file.

    ``vehicle`` (``procedures.Vehicle``) lets licensed procedures match; the
    simulator wins for virtual adapters. See ``app.services.procedures``.
    """
    from app.services.procedures import PROVIDERS, active_catalogue_size

    matches: dict[str, Any] = {}
    virtual = simulator_profile(adapter_id) is not None
    for provider in PROVIDERS:
        if virtual != (provider.key == "simulator"):
            continue  # Virtual adapters only run simulator steps; real ones never do.
        for fn_id, match in provider.lookup(adapter_id=adapter_id, vehicle=vehicle).items():
            matches.setdefault(fn_id, match)
    items = []
    for fn in SERVICE_FUNCTIONS_CATALOG:
        match = matches.get(fn["id"])
        items.append(
            {
                "id": fn["id"],
                "name": fn["name"],
                "uds_service": fn["uds_service"],
                "notes": fn["notes"],
                # Workshop conditions: "B" also needs engine off / battery checks.
                "conditions": "engine_off_battery" if fn["tier"] == "B" else "stationary",
                "checklist": CHECKLISTS.get(fn["id"], []),
                "availability": match.availability if match else "no_verified_procedure",
                "procedure": match.procedure if match else None,
                "source": match.source if match else None,
            }
        )
    kinds = {m.availability for m in matches.values()}
    catalogue = active_catalogue_size()
    if "simulated" in kinds:
        source = "simulator"
        note = (
            "Virtual vehicle: these procedures use the simulator's own identifiers. "
            "They are for training and testing, not for a real car."
        )
    elif "licensed" in kinds:
        source = "licensed"
        note = (
            "Procedures marked Licensed come from a licensed OEM data source for this "
            "make, model and year. Functions without one still need the manufacturer's "
            "service information."
        )
    else:
        source = "none"
        if catalogue and (vehicle is None or vehicle.year is None or not vehicle.model):
            note = (
                "Licensed procedures are matched on make, model and year. Confirm the "
                "vehicle to look them up."
            )
        else:
            note = (
                "No verified OEM procedures are on file for this vehicle yet. Use the "
                "manufacturer's service information for these functions."
            )
    return {
        "adapter_id": adapter_id,
        "source": source,
        "note": note,
        "vehicle": (
            {"make": vehicle.make, "model": vehicle.model, "year": vehicle.year}
            if vehicle is not None
            else None
        ),
        "licensed_catalogue": catalogue,
        "functions": items,
    }
