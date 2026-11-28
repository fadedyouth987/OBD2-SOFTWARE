"""Registry and module catalogue stay consistent (Task 6.2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.services.vehicle_registry import (
    GENERIC_PLATFORM,
    VEHICLE_PLATFORMS,
    decode_vin_platform,
    get_vehicle_platform,
    vin_model_year,
)

CATALOG = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/schemas/module_catalog.json").read_text()
)
NETWORKS = {
    "HS_CAN",
    "HS_CAN2",
    "MS_CAN",
    "SW_CAN",
    "J1850_PWM",
    "J1850_VPW",
    "KLINE",
    "ALDL",
    "ACP",
}
CAN = {"HS_CAN", "HS_CAN2", "MS_CAN", "SW_CAN"}


def _hex(v: str) -> int:
    return int(v, 16)


def _module(profile: str, module_id: str) -> dict:
    return next(m for m in VEHICLE_PLATFORMS[profile]["modules"] if m["id"] == module_id)


@pytest.mark.parametrize("profile", sorted(VEHICLE_PLATFORMS))
def test_every_platform_has_a_catalogue_family_and_valid_modules(profile: str):
    p = VEHICLE_PLATFORMS[profile]
    assert p["family"] in CATALOG["families"], p["family"]
    for m in p["modules"]:
        assert m["network"] in NETWORKS, (profile, m)
        if m["network"] in CAN:
            # A CAN module needs real ids; 0x7DF (functional) is never a module.
            tx, rx = _hex(m["tx"]), _hex(m["rx"])
            assert tx != 0x7DF and 0 < tx <= 0x1FFFFFFF and 0 < rx <= 0x1FFFFFFF, (profile, m)
        else:
            # Non-CAN modules carry no CAN ids, so the scanner never sends CAN to them.
            assert m["tx"] == "" and m["rx"] == "", (profile, m)
    assert len({(m["tx"], m["rx"]) for m in p["modules"] if m["tx"]}) == len(
        [m for m in p["modules"] if m["tx"]]
    ), f"{profile}: duplicate addresses"


def test_catalogue_sources_and_sweeps_are_all_defined():
    for name, fam in CATALOG["families"].items():
        for sweep in fam["sweeps"]:
            assert sweep in CATALOG["sweeps"], (name, sweep)
        for m in fam["modules"] + fam["subaddressed"]:
            assert m["source"] in CATALOG["sources"], (name, m)


def test_probe_is_tester_present_and_not_gated():
    policy = json.loads(
        (Path(__file__).resolve().parents[3] / "packages/schemas/safety_policy.json").read_text()
    )
    gated = {g["service_id"].upper() for g in policy["gated"]}
    assert CATALOG["probe"]["service"] == "0x3E"
    assert "0X3E" not in {g.upper() for g in gated}


def test_ranger_px3_uses_the_workshop_manual_networks():
    # Ford Ranger PX3 (2019) workshop manual 418-00: ABS, RCM, PSCM on HS-CAN2 (DIAG 2).
    for mid in ("ABS", "RCM", "PSCM", "SCCM", "IPMA", "OCSM"):
        assert _module("ford_ranger_px3", mid)["network"] == "HS_CAN2", mid
    for mid in ("PCM", "BCM", "GWM", "IPC", "APIM"):
        assert _module("ford_ranger_px3", mid)["network"] == "HS_CAN", mid
    assert len(VEHICLE_PLATFORMS["ford_ranger_px3"]["modules"]) >= 20


def test_gm_addressing_corrections():
    ve = "holden_commodore_ve_vf"
    assert (_module(ve, "TCM")["tx"], _module(ve, "TCM")["rx"]) == ("0x7E2", "0x7EA")
    assert (_module(ve, "EBCM")["tx"], _module(ve, "EBCM")["rx"]) == ("0x243", "0x643")
    assert (_module(ve, "BCM")["tx"], _module(ve, "BCM")["rx"]) == ("0x241", "0x641")


def test_other_corrections():
    assert _module("bmw_e90_dcan", "CAS")["rx"] == "0x640"
    assert _module("subaru_forester_wrx", "EYESIGHT")["tx"] == "0x787"
    assert (
        _module("jeep_ram_stellantis", "ABS")["tx"],
        _module("jeep_ram_stellantis", "ABS")["rx"],
    ) == (
        "0x747",
        "0x4C7",
    )
    assert _module("honda_civic_crv_jdm", "VSA/ABS")["tx"] == "0x18DA28F1"
    assert not any(m["id"] == "BCM" for m in VEHICLE_PLATFORMS["toyota_hilux_gun126"]["modules"]), (
        "0x750 is Toyota's sub-addressed gateway, not a plain BCM address"
    )
    falcon = VEHICLE_PLATFORMS["ford_falcon_fg_fgx"]["modules"]
    assert not any("/" in m["id"] for m in falcon), "BEM and ICC are separate modules"


@pytest.mark.parametrize(
    ("vin_char", "year"),
    [
        ("A", 2010),
        ("J", 2018),
        ("K", 2019),
        ("N", 2022),
        ("P", 2023),
        ("T", 2026),
        ("1", 2001),
        ("9", 2009),
    ],
)
def test_vin_model_year(vin_char: str, year: int):
    vin = "MNAUMFF50" + vin_char + "W123456"
    assert vin_model_year(vin, today_year=2026) == year


def test_vin_model_year_rejects_bad_input():
    assert vin_model_year("SHORT") is None
    assert vin_model_year("MNAUMFF50IW123456", today_year=2026) is None  # I is never a year code
    # A letter more than a year ahead belongs to the previous cycle.
    assert vin_model_year("MNAUMFF50YW123456", today_year=2026) == 2000


def test_rangers_decode_by_model_year():
    assert decode_vin_platform("MNAUMFF50EW123456")["profile"] == "ford_ranger_px_px2"  # 2014
    assert decode_vin_platform("MNAUMFF50KW123456")["profile"] == "ford_ranger_px3"  # 2019
    assert decode_vin_platform("MNAUMFF50PW123456")["profile"] == "ford_ranger_next_gen"  # 2023
    changeover = decode_vin_platform("MNAUMFF50NW123456")  # 2022: PX3 or next gen
    assert changeover["profile"] == "ford_ranger_px3"
    assert changeover["ambiguous_with"] == ["ford_ranger_next_gen"]


def test_bt50_generations_are_split_from_cx5():
    assert decode_vin_platform("JM0KF4W7A00123456")["profile"] == "mazda_cx5_mazda3"
    assert decode_vin_platform("MM7UR4DA0EW123456")["profile"] == "mazda_bt50_up_ur"  # 2014
    assert VEHICLE_PLATFORMS["mazda_bt50_up_ur"]["family"] == "ford"


def test_legacy_profile_still_resolves():
    assert get_vehicle_platform("mazda_bt50_cx5") is VEHICLE_PLATFORMS["mazda_cx5_mazda3"]
    assert get_vehicle_platform("nope") is GENERIC_PLATFORM
    assert decode_vin_platform("ZZZ12345678901234")["family"] == "generic"
