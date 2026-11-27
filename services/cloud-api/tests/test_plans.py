"""The one plan table (packages/schemas/plan_features.json) and what is built from it."""

from __future__ import annotations

import copy
import json
import os

import pytest

os.environ.setdefault("AWS_REGION", "ap-southeast-2")

from app.db.models import SubscriptionTier  # noqa: E402
from app.services import billing, signing  # noqa: E402
from app.services.plans import DEFAULT_PATH, PlanFileError, load_plans, parse_plans  # noqa: E402

RAW = json.loads(DEFAULT_PATH.read_text(encoding="utf-8"))

# The four plans as they were hard-coded before the plan file (billing.py at 0851a9d).
# Moving the table must not change any of them.
GOLDEN = {
    "COMMUNITY": (0, 0, 5, 0, 1, 1, ()),
    "PRO": (39, 390, 100, 25, 1, 1, ("UDS_ACTIVE",)),
    "WORKSHOP": (99, 990, 400, 100, 5, 1, ("UDS_ACTIVE", "CAN_RE_PRO", "J2534")),
    "FLEET": (229, 2290, 1000, 100, 10, 3, ("UDS_ACTIVE", "CAN_RE_PRO", "J2534")),
}


def _q(tier: str) -> tuple:
    q = billing.TIER_QUOTAS[SubscriptionTier(tier)]
    return (
        q.monthly_price_aud,
        q.annual_price_aud,
        q.ai_diagnoses,
        q.schematic_pages,
        q.seats,
        q.sites,
        tuple(q.features),
    )


@pytest.mark.parametrize("tier", sorted(GOLDEN))
def test_existing_plans_are_unchanged(tier: str):
    assert _q(tier) == GOLDEN[tier]


def test_existing_paid_and_immo_sets_are_unchanged_plus_mobile():
    assert billing.PAID_TIERS == {
        SubscriptionTier.MOBILE,
        SubscriptionTier.PRO,
        SubscriptionTier.WORKSHOP,
        SubscriptionTier.FLEET,
    }
    assert billing.IMMO_ELIGIBLE == {SubscriptionTier.WORKSHOP, SubscriptionTier.FLEET}
    assert billing.IMMO_ADDON["eligible_tiers"] == ("WORKSHOP", "FLEET")
    for tier, feats in GOLDEN.items():
        assert signing.features_for_tier(tier) == list(feats[6])


def test_mobile_plan():
    assert _q("MOBILE") == (15, 150, 40, 0, 1, 1, ())
    rank = billing._TIER_RANK
    assert (
        rank[SubscriptionTier.COMMUNITY]
        < rank[SubscriptionTier.MOBILE]
        < rank[SubscriptionTier.PRO]
    )
    assert signing.normalize_tier("mobile") == "MOBILE"
    assert signing.features_for_tier("MOBILE") == []
    assert signing.features_for_tier("MOBILE", immo_entitled=True) == []


def test_catalog_lists_mobile_and_app_features():
    cat = billing.catalog_public()
    assert [t["tier"] for t in cat["tiers"]] == ["COMMUNITY", "MOBILE", "PRO", "WORKSHOP", "FLEET"]
    keys = {f["key"] for f in cat["app_features"]}
    assert {"READ_CODES", "MOBILE_RECORDING", "CUSTOMER_REPORT", "UDS_ACTIVE"} <= keys
    rec = next(f for f in cat["app_features"] if f["key"] == "MOBILE_RECORDING")
    assert "COMMUNITY" not in rec["tiers"]
    report = next(f for f in cat["app_features"] if f["key"] == "CUSTOMER_REPORT")
    assert "COMMUNITY" in report["tiers"]  # same as the web report today (D3)


def test_mobile_price_maps_to_mobile(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("STRIPE_PRICE_MOBILE_MONTH", "price_unit_mobile_m")
    billing.get_settings.cache_clear()
    try:
        assert billing.map_price_ids(["price_unit_mobile_m"]) == (SubscriptionTier.MOBILE, False)
    finally:
        billing.get_settings.cache_clear()


def test_desktop_only_app_features_match_lease_features():
    plans = load_plans()
    by_name = plans.by_name()
    for f in plans.app_features:
        if f["key"] in {"UDS_ACTIVE", "CAN_RE_PRO", "J2534"}:
            assert f["desktop_only"] is True
            assert sorted(f["tiers"]) == sorted(
                t for t, p in by_name.items() if f["key"] in p.lease_features
            )


def _broken(mutate) -> dict:
    data = copy.deepcopy(RAW)
    mutate(data)
    return data


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda d: d["tiers"].append(copy.deepcopy(d["tiers"][1])), "listed twice"),
        (lambda d: d["tiers"][2]["lease_features"].append("IMMO_PROGRAM"), "unknown lease"),
        (lambda d: d["tiers"][1].pop("seats"), "missing seats"),
        (lambda d: d["tiers"][1].update(paid=False), "only free tier"),
        (lambda d: d["tiers"][1].update(monthly_price_aud=0), "no monthly price"),
        (lambda d: d["tiers"][1].update(rank=2), "share a rank"),
        (lambda d: d["tiers"][1].update(ai_diagnoses=-1), "integer >= 0"),
        (lambda d: d["app_features"][0]["tiers"].append("GOLD"), "unknown tiers"),
    ],
)
def test_bad_plan_files_are_refused(mutate, message: str):
    with pytest.raises(PlanFileError, match=message):
        parse_plans(_broken(mutate))


def test_missing_plan_file_is_refused(tmp_path):
    with pytest.raises(PlanFileError, match="cannot read"):
        load_plans.__wrapped__(str(tmp_path / "nope.json"))
