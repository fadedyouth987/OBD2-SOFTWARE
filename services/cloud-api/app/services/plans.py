"""The plan table: one file, ``packages/schemas/plan_features.json``, read by the API,
the web app and the mobile app so a plan means the same thing everywhere.

The API refuses to start if the file is missing or breaks a rule below; a bad
edit blocks the deploy instead of reaching customers.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_PATH = _REPO_ROOT / "packages" / "schemas" / "plan_features.json"

# The edge daemon's Feature enum. A plan may only grant these on a lease.
LEASE_FEATURES = frozenset({"UDS_ACTIVE", "CAN_RE_PRO", "J2534"})
_TIER_FIELDS = (
    "tier",
    "display_name",
    "rank",
    "paid",
    "immo_eligible",
    "monthly_price_aud",
    "annual_price_aud",
    "ai_diagnoses",
    "schematic_pages",
    "seats",
    "sites",
    "lease_features",
    "description",
)


class PlanFileError(RuntimeError):
    """plan_features.json is missing or breaks a rule."""


@dataclass(frozen=True)
class PlanTier:
    tier: str
    display_name: str
    rank: int
    paid: bool
    immo_eligible: bool
    monthly_price_aud: int
    annual_price_aud: int
    ai_diagnoses: int
    schematic_pages: int
    seats: int
    sites: int
    lease_features: tuple[str, ...]
    description: str


@dataclass(frozen=True)
class Plans:
    version: str
    tiers: tuple[PlanTier, ...]
    app_features: tuple[dict[str, Any], ...]

    def by_name(self) -> dict[str, PlanTier]:
        return {t.tier: t for t in self.tiers}


def _int(row: dict[str, Any], field: str, minimum: int) -> int:
    value = row[field]
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise PlanFileError(f"{row.get('tier')}.{field} must be an integer >= {minimum}")
    return value


def parse_plans(data: dict[str, Any]) -> Plans:
    tiers: list[PlanTier] = []
    for row in data.get("tiers") or []:
        missing = [f for f in _TIER_FIELDS if f not in row]
        if missing:
            raise PlanFileError(f"tier {row.get('tier')!r} is missing {', '.join(missing)}")
        feats = tuple(row["lease_features"])
        unknown = set(feats) - LEASE_FEATURES
        if unknown:
            raise PlanFileError(f"{row['tier']} grants unknown lease features {sorted(unknown)}")
        if not isinstance(row["paid"], bool) or not isinstance(row["immo_eligible"], bool):
            raise PlanFileError(f"{row['tier']}.paid and .immo_eligible must be true or false")
        tiers.append(
            PlanTier(
                tier=str(row["tier"]),
                display_name=str(row["display_name"]),
                rank=_int(row, "rank", 0),
                paid=row["paid"],
                immo_eligible=row["immo_eligible"],
                monthly_price_aud=_int(row, "monthly_price_aud", 0),
                annual_price_aud=_int(row, "annual_price_aud", 0),
                ai_diagnoses=_int(row, "ai_diagnoses", 0),
                schematic_pages=_int(row, "schematic_pages", 0),
                seats=_int(row, "seats", 1),
                sites=_int(row, "sites", 1),
                lease_features=feats,
                description=str(row["description"]),
            )
        )
    names = [t.tier for t in tiers]
    if len(set(names)) != len(names):
        raise PlanFileError("a tier is listed twice")
    ranks = [t.rank for t in tiers]
    if len(set(ranks)) != len(ranks):
        raise PlanFileError("two tiers share a rank")
    free = [t for t in tiers if not t.paid]
    if len(free) != 1 or free[0].tier != "COMMUNITY" or min(ranks) != free[0].rank:
        raise PlanFileError("COMMUNITY must be the only free tier and rank lowest")
    for t in tiers:
        if t.paid and t.monthly_price_aud <= 0:
            raise PlanFileError(f"{t.tier} is paid but has no monthly price")
    known = set(names)
    for f in data.get("app_features") or []:
        bad = set(f.get("tiers") or []) - known
        if bad:
            raise PlanFileError(f"app feature {f.get('key')} names unknown tiers {sorted(bad)}")
    return Plans(
        version=str(data.get("plans_version") or ""),
        tiers=tuple(sorted(tiers, key=lambda t: t.rank)),
        app_features=tuple(data.get("app_features") or []),
    )


@lru_cache
def load_plans(path: str | None = None) -> Plans:
    target = Path(path or os.environ.get("PLAN_FEATURES_PATH") or DEFAULT_PATH)
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise PlanFileError(f"cannot read plan file {target}: {exc}") from exc
    return parse_plans(data)
