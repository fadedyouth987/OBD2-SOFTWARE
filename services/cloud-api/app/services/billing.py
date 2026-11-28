"""Subscription catalog, quota metering, and Stripe event application."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import StripeEvent, SubscriptionTier, Tenant
from app.db.session import owner_engine, tenant_session

log = logging.getLogger(__name__)

QUOTA_TZ = ZoneInfo("Australia/Adelaide")
CURRENCY = "AUD"
OVERAGE_AUD = 0.25
TRIAL_DAYS = 14
PAID_TIERS = frozenset({SubscriptionTier.PRO, SubscriptionTier.WORKSHOP, SubscriptionTier.FLEET})
IMMO_ELIGIBLE = frozenset({SubscriptionTier.WORKSHOP, SubscriptionTier.FLEET})

# Rank used to detect downgrades (and to bump lease_version).
_TIER_RANK = {
    SubscriptionTier.COMMUNITY: 0,
    SubscriptionTier.PRO: 1,
    SubscriptionTier.WORKSHOP: 2,
    SubscriptionTier.FLEET: 3,
}


@dataclass(frozen=True)
class TierQuota:
    display_name: str
    monthly_price_aud: int
    annual_price_aud: int
    ai_diagnoses: int
    schematic_pages: int
    seats: int
    sites: int
    features: tuple[str, ...]
    description: str


TIER_QUOTAS: dict[SubscriptionTier, TierQuota] = {
    SubscriptionTier.COMMUNITY: TierQuota(
        display_name="Community",
        monthly_price_aud=0,
        annual_price_aud=0,
        ai_diagnoses=5,
        schematic_pages=0,
        seats=1,
        sites=1,
        features=(),
        description="Read-only OBD-II diagnostics. One seat, no schematics, no paid edge features.",
    ),
    SubscriptionTier.PRO: TierQuota(
        display_name="Pro",
        monthly_price_aud=39,
        annual_price_aud=390,
        ai_diagnoses=100,
        schematic_pages=25,
        seats=1,
        sites=1,
        features=("UDS_ACTIVE",),
        description=(
            "Active UDS for a single technician. 100 AI diagnoses and 25 schematic pages a month."
        ),
    ),
    SubscriptionTier.WORKSHOP: TierQuota(
        display_name="Workshop",
        monthly_price_aud=99,
        annual_price_aud=990,
        ai_diagnoses=400,
        schematic_pages=100,
        seats=5,
        sites=1,
        features=("UDS_ACTIVE", "CAN_RE_PRO", "J2534"),
        description="Shop plan: CAN reverse-engineering, J2534, five seats, 400 AI diagnoses.",
    ),
    SubscriptionTier.FLEET: TierQuota(
        display_name="Fleet",
        monthly_price_aud=229,
        annual_price_aud=2290,
        ai_diagnoses=1000,
        schematic_pages=100,
        seats=10,
        sites=3,
        features=("UDS_ACTIVE", "CAN_RE_PRO", "J2534"),
        description="Multi-site plan: ten seats across three sites, 1,000 AI diagnoses a month.",
    ),
}

IMMO_ADDON = {
    "monthly_price_aud": 49,
    "annual_price_aud": 490,
    "eligible_tiers": ("WORKSHOP", "FLEET"),
    "feature": "IMMO_PROGRAM",
    "description": (
        "Immobilizer / key-learn add-on. Still gated by AASRA, "
        "technician accreditation, and OEM policy."
    ),
}


class BillingApplyError(Exception):
    """Webhook processing failed; the HTTP layer should not return 2xx."""

    def __init__(self, message: str, status_code: int = 500) -> None:
        super().__init__(message)
        self.status_code = status_code


def today_adelaide() -> date:
    """Quota periods follow the calendar month in Australia/Adelaide."""
    return datetime.now(QUOTA_TZ).date()


def period_start_adelaide(day: date | None = None) -> date:
    d = day or today_adelaide()
    return d.replace(day=1)


def catalog_public() -> dict[str, Any]:
    settings = get_settings()
    tiers = []
    for tier, q in TIER_QUOTAS.items():
        tiers.append(
            {
                "tier": tier.value,
                "display_name": q.display_name,
                "monthly_price_aud": q.monthly_price_aud,
                "annual_price_aud": q.annual_price_aud,
                "annual_is_10_for_12": q.monthly_price_aud > 0,
                "ai_diagnoses": q.ai_diagnoses,
                "schematic_pages": q.schematic_pages,
                "seats": q.seats,
                "sites": q.sites,
                "features": list(q.features),
                "description": q.description,
                "immo_addon_available": tier in IMMO_ELIGIBLE,
            }
        )
    return {
        "currency": CURRENCY,
        "timezone": str(QUOTA_TZ),
        "quota_reset": "calendar_month",
        "trial_days": TRIAL_DAYS,
        "trial_tier": SubscriptionTier.WORKSHOP.value,
        "trial_requires_card": True,
        "overage_aud": OVERAGE_AUD,
        "overage_enabled": settings.stripe_ai_overage_enabled,
        "immo_addon": IMMO_ADDON,
        "tiers": tiers,
    }


def parse_tier(value: str | SubscriptionTier | None) -> SubscriptionTier:
    if isinstance(value, SubscriptionTier):
        return value
    if not value:
        return SubscriptionTier.COMMUNITY
    try:
        return SubscriptionTier(str(value).strip().upper())
    except ValueError:
        return SubscriptionTier.COMMUNITY


def quotas_for(tier: str | SubscriptionTier) -> TierQuota:
    return TIER_QUOTAS[parse_tier(tier)]


def effective_tier(
    stored: SubscriptionTier,
    *,
    billing_status: str | None = None,
    billing_grace_until: datetime | None = None,
    now: datetime | None = None,
) -> SubscriptionTier:
    """Return the entitlements tier, degrading after a past-due grace period."""
    if stored == SubscriptionTier.COMMUNITY:
        return stored
    status = (billing_status or "none").lower()
    if status in {"canceled", "unpaid", "incomplete_expired"}:
        return SubscriptionTier.COMMUNITY
    if status == "past_due":
        now = now or datetime.now(UTC)
        grace = billing_grace_until
        if grace is not None and grace.tzinfo is None:
            grace = grace.replace(tzinfo=UTC)
        if grace is None or now >= grace:
            return SubscriptionTier.COMMUNITY
    return stored


def maybe_expire_grace(session: Session, tenant: Tenant, *, now: datetime | None = None) -> Tenant:
    """Persist a Community downgrade once the past-due grace window has elapsed."""
    now = now or datetime.now(UTC)
    if tenant.subscription_tier == SubscriptionTier.COMMUNITY:
        return tenant
    if (tenant.stripe_subscription_status or "").lower() != "past_due":
        return tenant
    if (
        effective_tier(
            tenant.subscription_tier,
            billing_status=tenant.stripe_subscription_status,
            billing_grace_until=tenant.billing_grace_until,
            now=now,
        )
        != SubscriptionTier.COMMUNITY
    ):
        return tenant
    _downgrade_to_community(tenant, status="unpaid", bump=True)
    session.add(tenant)
    log.info("tenant %s past-due grace expired; degraded to COMMUNITY", tenant.id)
    return tenant


def _downgrade_to_community(tenant: Tenant, *, status: str, bump: bool) -> None:
    if bump and (tenant.subscription_tier != SubscriptionTier.COMMUNITY or tenant.immo_entitled):
        tenant.lease_version = int(tenant.lease_version or 0) + 1
    tenant.subscription_tier = SubscriptionTier.COMMUNITY
    tenant.immo_entitled = False
    tenant.stripe_subscription_status = status
    tenant.billing_grace_until = None


def entitlement_for(tenant: Tenant) -> dict[str, Any]:
    tier = effective_tier(
        tenant.subscription_tier,
        billing_status=tenant.stripe_subscription_status,
        billing_grace_until=tenant.billing_grace_until,
    )
    q = quotas_for(tier)
    return {
        "tier": tier.value,
        "stored_tier": tenant.subscription_tier.value,
        "billing_status": tenant.stripe_subscription_status,
        "immo_entitled": bool(tenant.immo_entitled) and tier in IMMO_ELIGIBLE,
        "lease_version": int(tenant.lease_version or 0),
        "ai_diagnoses": q.ai_diagnoses,
        "schematic_pages": q.schematic_pages,
        "seats": q.seats,
        "sites": q.sites,
        "features": list(q.features),
        "billing_grace_until": (
            tenant.billing_grace_until.isoformat() if tenant.billing_grace_until else None
        ),
        "trial_ends_at": tenant.trial_ends_at.isoformat() if tenant.trial_ends_at else None,
        "trial_used": bool(tenant.trial_used),
    }


def map_price_ids(price_ids: list[str]) -> tuple[SubscriptionTier | None, bool]:
    """Map Stripe price IDs to a base tier and IMMO add-on flag.

    Unknown IDs are ignored. Conflicting base-tier prices raise BillingApplyError.
    Returns (None, immo) when no base-tier price is present.
    """
    settings = get_settings()
    catalog = settings.price_catalog()
    inverse: dict[str, str] = {v: k for k, v in catalog.items() if v}
    base: SubscriptionTier | None = None
    immo = False
    for pid in price_ids:
        if not pid:
            continue
        label = inverse.get(pid)
        if label is None:
            log.warning("unmapped Stripe price id %s", pid)
            continue
        if label.startswith("IMMO:"):
            immo = True
            continue
        if label in {"SEAT", "SITE", "AI_OVERAGE"}:
            continue
        tier_name = label.split(":", 1)[0]
        try:
            found = SubscriptionTier(tier_name)
        except ValueError:
            continue
        if base is not None and found != base:
            raise BillingApplyError(
                f"subscription contains conflicting tier prices {base.value} and {found.value}",
                status_code=500,
            )
        base = found
    return base, immo


def extract_price_ids(obj: dict[str, Any]) -> list[str]:
    ids: list[str] = []

    def _price(value: Any) -> None:
        if isinstance(value, str) and value:
            ids.append(value)
        elif isinstance(value, dict):
            pid = value.get("id") or value.get("price")
            if isinstance(pid, str) and pid:
                ids.append(pid)
            elif isinstance(pid, dict) and pid.get("id"):
                ids.append(str(pid["id"]))

    for key in ("items", "line_items", "lines", "display_items"):
        block = obj.get(key)
        data = block.get("data") if isinstance(block, dict) else block
        if not isinstance(data, list):
            continue
        for item in data:
            if not isinstance(item, dict):
                continue
            _price(item.get("price"))
            plan = item.get("plan")
            if isinstance(plan, dict) and plan.get("id"):
                ids.append(str(plan["id"]))

    sub = obj.get("subscription")
    if isinstance(sub, dict):
        ids.extend(extract_price_ids(sub))
    return list(dict.fromkeys(ids))


def extract_customer_and_subscription(obj: dict[str, Any]) -> tuple[str | None, str | None]:
    def _id(value: Any) -> str | None:
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict) and value.get("id"):
            return str(value["id"])
        return None

    customer = _id(obj.get("customer"))
    subscription = _id(obj.get("subscription"))
    # Invoice objects expose subscription directly; subscription objects are their own id.
    if subscription is None and obj.get("object") == "subscription":
        subscription = _id(obj.get("id"))
    if customer is None and obj.get("object") == "customer":
        customer = _id(obj.get("id"))
    return customer, subscription


def lookup_tenant_id(
    *,
    customer_id: str | None = None,
    subscription_id: str | None = None,
    client_reference_id: str | None = None,
) -> UUID | None:
    """Resolve a tenant using the owner (bypass-RLS) connection."""
    with owner_engine().connect() as conn:
        if customer_id:
            row = conn.execute(
                text("SELECT id FROM tenants WHERE stripe_customer_id = :c"),
                {"c": customer_id},
            ).first()
            if row:
                return UUID(str(row[0]))
        if subscription_id:
            row = conn.execute(
                text("SELECT id FROM tenants WHERE stripe_subscription_id = :s"),
                {"s": subscription_id},
            ).first()
            if row:
                return UUID(str(row[0]))
        if client_reference_id:
            try:
                tid = UUID(str(client_reference_id))
            except ValueError:
                return None
            row = conn.execute(
                text("SELECT id FROM tenants WHERE id = :i"),
                {"i": tid},
            ).first()
            if row:
                return UUID(str(row[0]))
    return None


def apply_subscription_state(
    tenant: Tenant,
    *,
    tier: SubscriptionTier | None,
    immo_entitled: bool | None,
    status: str,
    customer_id: str | None,
    subscription_id: str | None,
    event_created: int,
    grace_until: datetime | None = None,
    trial_ends_at: datetime | None = None,
) -> None:
    """Mutate tenant billing fields. Caller is responsible for the session add."""
    previous = tenant.subscription_tier
    prev_immo = bool(tenant.immo_entitled)
    if customer_id:
        tenant.stripe_customer_id = customer_id
    if subscription_id:
        tenant.stripe_subscription_id = subscription_id
    tenant.stripe_subscription_status = status
    tenant.billing_event_created = max(int(tenant.billing_event_created or 0), event_created)
    if grace_until is not None or status != "past_due":
        tenant.billing_grace_until = grace_until
    if trial_ends_at is not None:
        tenant.trial_ends_at = trial_ends_at
    if status in {"trialing", "active"} and trial_ends_at:
        tenant.trial_used = True
    if status in {"trialing"}:
        tenant.trial_used = True

    new_tier = previous
    if tier is not None:
        new_tier = tier
    if status in {"canceled", "unpaid", "incomplete_expired"}:
        new_tier = SubscriptionTier.COMMUNITY

    new_immo = prev_immo if immo_entitled is None else bool(immo_entitled)
    if new_tier not in IMMO_ELIGIBLE:
        new_immo = False

    downgrade = _TIER_RANK[new_tier] < _TIER_RANK[previous] or (prev_immo and not new_immo)
    if downgrade:
        tenant.lease_version = int(tenant.lease_version or 0) + 1
    tenant.subscription_tier = new_tier
    tenant.immo_entitled = new_immo


def apply_payment_failed(
    tenant: Tenant, *, event_created: int, now: datetime | None = None
) -> None:
    settings = get_settings()
    now = now or datetime.now(UTC)
    existing_grace = tenant.billing_grace_until
    if existing_grace is not None and existing_grace.tzinfo is None:
        existing_grace = existing_grace.replace(tzinfo=UTC)
    # Already in a grace window that has elapsed → degrade.
    if (
        (tenant.stripe_subscription_status or "").lower() == "past_due"
        and existing_grace is not None
        and now >= existing_grace
    ):
        _downgrade_to_community(tenant, status="unpaid", bump=True)
        tenant.billing_event_created = max(int(tenant.billing_event_created or 0), event_created)
        return
    grace = now + timedelta(days=int(settings.stripe_past_due_grace_days or 7))
    tenant.stripe_subscription_status = "past_due"
    tenant.billing_grace_until = grace
    tenant.billing_event_created = max(int(tenant.billing_event_created or 0), event_created)


ACTIONABLE_EVENTS = frozenset(
    {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.trial_will_end",
        "invoice.paid",
        "invoice.payment_succeeded",
        "invoice.payment_failed",
    }
)


def event_already_recorded(session: Session, event_id: str) -> bool:
    return session.get(StripeEvent, event_id) is not None


def record_event(
    session: Session, event_id: str, event_type: str, tenant_id: UUID, payload: dict
) -> None:
    session.add(
        StripeEvent(
            event_id=event_id,
            tenant_id=tenant_id,
            event_type=event_type,
            payload=payload,
        )
    )


def _subscription_status(obj: dict[str, Any], default: str = "active") -> str:
    status = obj.get("status")
    # A Checkout Session's own status ("complete", "open") isn't the subscription's.
    if isinstance(status, str) and status and obj.get("object") != "checkout.session":
        return status
    sub = obj.get("subscription")
    if isinstance(sub, dict) and isinstance(sub.get("status"), str):
        return str(sub["status"])
    return default


def _ts(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        return datetime.fromtimestamp(int(value), tz=UTC)
    except (TypeError, ValueError, OSError):
        return None


def apply_stripe_event(session: Session, event: dict[str, Any]) -> dict[str, Any]:
    """Apply one verified Stripe event inside an existing tenant_session.

    The caller must have already opened the session for the resolved tenant.
    """
    event_id = str(event.get("id") or "")
    event_type = str(event.get("type") or "")
    event_created = int(event.get("created") or 0)
    obj = event.get("data", {}).get("object") or {}
    if not isinstance(obj, dict):
        obj = {}

    if not event_id:
        raise BillingApplyError("Stripe event is missing an id", status_code=400)

    tenant = session.query(Tenant).one_or_none()
    if tenant is None:
        raise BillingApplyError("tenant not visible in session", status_code=500)

    if event_already_recorded(session, event_id):
        return {"status": "duplicate", "event_id": event_id, "tenant_id": str(tenant.id)}

    # Stale / out-of-order events are recorded but do not rewind entitlements.
    if event_created and int(tenant.billing_event_created or 0) > event_created:
        record_event(session, event_id, event_type, tenant.id, event)
        return {
            "status": "stale",
            "event_id": event_id,
            "tenant_id": str(tenant.id),
            "stored_created": int(tenant.billing_event_created or 0),
        }

    customer_id, subscription_id = extract_customer_and_subscription(obj)
    if obj.get("object") == "checkout.session":
        # Bind IDs first so later subscription events can resolve the tenant.
        if customer_id:
            tenant.stripe_customer_id = customer_id
        if subscription_id:
            tenant.stripe_subscription_id = subscription_id

    price_ids = extract_price_ids(obj)
    # Invoice objects often only have subscription/customer ids; paid invoices
    # restore an active status without needing to remake the price map if empty.
    tier, immo = map_price_ids(price_ids) if price_ids else (None, None)

    if event_type in {"invoice.payment_failed"}:
        apply_payment_failed(tenant, event_created=event_created)
    elif event_type == "customer.subscription.deleted":
        apply_subscription_state(
            tenant,
            tier=SubscriptionTier.COMMUNITY,
            immo_entitled=False,
            status="canceled",
            customer_id=customer_id,
            subscription_id=subscription_id,
            event_created=event_created,
        )
        tenant.stripe_subscription_id = None
    elif event_type in {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "invoice.paid",
        "invoice.payment_succeeded",
        "customer.subscription.trial_will_end",
    }:
        status = _subscription_status(obj, default="active")
        if event_type in {"invoice.paid", "invoice.payment_succeeded"} and status == "active":
            # A successful invoice clears past_due / unpaid.
            status = "active"
        trial_end = _ts(
            obj.get("trial_end") or (obj.get("subscription") or {}).get("trial_end")
            if isinstance(obj.get("subscription"), dict)
            else obj.get("trial_end")
        )
        # For invoices, don't turn off IMMO just because line items are empty.
        immo_flag: bool | None
        if event_type in {
            "invoice.paid",
            "invoice.payment_succeeded",
            "customer.subscription.trial_will_end",
        }:
            immo_flag = immo if price_ids else None
            if tier is None and not price_ids:
                tier = (
                    tenant.subscription_tier
                    if tenant.subscription_tier != SubscriptionTier.COMMUNITY
                    else None
                )
        else:
            immo_flag = bool(immo) if price_ids else None
            # subscription.updated with only IMMO removed should clear it
            if price_ids and event_type.startswith("customer.subscription."):
                immo_flag = bool(immo)
        if event_type == "customer.subscription.trial_will_end":
            # Informational; keep entitlements, just record trial end.
            pass
        apply_subscription_state(
            tenant,
            tier=tier,
            immo_entitled=immo_flag,
            status=status
            if event_type != "customer.subscription.trial_will_end"
            else (tenant.stripe_subscription_status or status),
            customer_id=customer_id,
            subscription_id=subscription_id,
            event_created=event_created,
            grace_until=None if status == "active" else tenant.billing_grace_until,
            trial_ends_at=trial_end,
        )
    else:
        record_event(session, event_id, event_type, tenant.id, event)
        return {"status": "ignored", "event_id": event_id, "tenant_id": str(tenant.id)}

    session.add(tenant)
    record_event(session, event_id, event_type, tenant.id, event)
    return {
        "status": "applied",
        "event_id": event_id,
        "tenant_id": str(tenant.id),
        "active_tier": effective_tier(
            tenant.subscription_tier,
            billing_status=tenant.stripe_subscription_status,
            billing_grace_until=tenant.billing_grace_until,
        ).value,
        "immo_entitled": bool(tenant.immo_entitled),
        "lease_version": int(tenant.lease_version or 0),
        "billing_status": tenant.stripe_subscription_status,
    }


def resolve_event_tenant_id(event: dict[str, Any]) -> UUID | None:
    obj = event.get("data", {}).get("object") or {}
    if not isinstance(obj, dict):
        obj = {}
    customer_id, subscription_id = extract_customer_and_subscription(obj)
    client_ref = obj.get("client_reference_id")
    if not client_ref:
        meta = obj.get("metadata") if isinstance(obj.get("metadata"), dict) else {}
        client_ref = meta.get("tenant_id") if isinstance(meta, dict) else None
    return lookup_tenant_id(
        customer_id=customer_id,
        subscription_id=subscription_id,
        client_reference_id=str(client_ref) if client_ref else None,
    )


def charge_ai_quota(tenant_id: UUID) -> tuple[bool, int, int]:
    """Atomically consume one AI diagnosis against the monthly quota.

    Uses a single UPDATE ... RETURNING so concurrent requests cannot both
    slip under the cap. Quota months follow the calendar in Australia/Adelaide.
    When overage is enabled the increment is always allowed past the included
    cap (metered; billing of the overage itself is Stripe-side and off by default).
    """
    settings = get_settings()
    overage = bool(settings.stripe_ai_overage_enabled)
    today = today_adelaide()
    period = period_start_adelaide(today)

    with tenant_session(tenant_id) as session:
        tenant = session.get(Tenant, tenant_id)
        if tenant is None:
            return False, 0, 0
        maybe_expire_grace(session, tenant)
        session.flush()
        stored = tenant.subscription_tier
        status = tenant.stripe_subscription_status
        grace = tenant.billing_grace_until
        # Reset is done in SQL together with the increment so it stays atomic.
        limit = quotas_for(
            effective_tier(stored, billing_status=status, billing_grace_until=grace)
        ).ai_diagnoses
        # First, roll the period if needed (no increment yet).
        session.execute(
            text(
                """
                UPDATE tenants
                   SET ai_diagnoses_used = 0,
                       ai_quota_period_start = :period
                 WHERE id = :id
                   AND (ai_quota_period_start IS NULL
                        OR ai_quota_period_start < :period)
                """
            ),
            {"id": tenant_id, "period": period},
        )
        if overage:
            row = session.execute(
                text(
                    """
                    UPDATE tenants
                       SET ai_diagnoses_used = ai_diagnoses_used + 1
                     WHERE id = :id
                 RETURNING ai_diagnoses_used
                    """
                ),
                {"id": tenant_id},
            ).first()
        else:
            row = session.execute(
                text(
                    """
                    UPDATE tenants
                       SET ai_diagnoses_used = ai_diagnoses_used + 1
                     WHERE id = :id
                       AND ai_diagnoses_used < :limit
                 RETURNING ai_diagnoses_used
                    """
                ),
                {"id": tenant_id, "limit": limit},
            ).first()
        if row is None:
            used = session.execute(
                text("SELECT ai_diagnoses_used FROM tenants WHERE id = :id"),
                {"id": tenant_id},
            ).scalar_one()
            return False, int(used), limit
        return True, int(row[0]), limit


def refund_ai_quota(tenant_id: UUID) -> int:
    """Give back one AI diagnosis reserved by ``charge_ai_quota`` when the model failed.

    Only within the same quota month; never below zero. Returns the new count.
    """
    period = current_quota_period()
    with tenant_session(tenant_id) as session:
        row = session.execute(
            text(
                """
                UPDATE tenants
                   SET ai_diagnoses_used = GREATEST(0, ai_diagnoses_used - 1)
                 WHERE id = :id
                   AND ai_quota_period_start >= :period
             RETURNING ai_diagnoses_used
                """
            ),
            {"id": tenant_id, "period": period},
        ).first()
        return int(row[0]) if row else 0


def charge_schematic_pages(tenant_id: UUID, pages: int) -> tuple[bool, int, int]:
    """Atomically consume schematic page views. ``pages`` must be >= 1."""
    if pages < 1:
        raise ValueError("pages must be >= 1")
    today = today_adelaide()
    period = period_start_adelaide(today)
    # schematic_pages_used is not reset on a dedicated period column; we
    # reuse ai_quota_period_start as the shared calendar-month watermark
    # and reset schematic usage when that month rolls.
    with tenant_session(tenant_id) as session:
        tenant = session.get(Tenant, tenant_id)
        if tenant is None:
            return False, 0, 0
        maybe_expire_grace(session, tenant)
        session.flush()
        limit = quotas_for(
            effective_tier(
                tenant.subscription_tier,
                billing_status=tenant.stripe_subscription_status,
                billing_grace_until=tenant.billing_grace_until,
            )
        ).schematic_pages
        session.execute(
            text(
                """
                UPDATE tenants
                   SET schematic_pages_used = 0,
                       ai_diagnoses_used = CASE
                         WHEN ai_quota_period_start IS NULL OR ai_quota_period_start < :period
                         THEN 0 ELSE ai_diagnoses_used END,
                       ai_quota_period_start = :period
                 WHERE id = :id
                   AND (ai_quota_period_start IS NULL
                        OR ai_quota_period_start < :period)
                """
            ),
            {"id": tenant_id, "period": period},
        )
        row = session.execute(
            text(
                """
                UPDATE tenants
                   SET schematic_pages_used = schematic_pages_used + :pages
                 WHERE id = :id
                   AND schematic_pages_used + :pages <= :limit
             RETURNING schematic_pages_used
                """
            ),
            {"id": tenant_id, "pages": pages, "limit": limit},
        ).first()
        if row is None:
            used = session.execute(
                text("SELECT schematic_pages_used FROM tenants WHERE id = :id"),
                {"id": tenant_id},
            ).scalar_one()
            return False, int(used), limit
        return True, int(row[0]), limit


def current_quota_period() -> date:
    """The first day of this quota month (calendar month in Australia/Adelaide)."""
    return period_start_adelaide(today_adelaide())


def refund_schematic_pages(
    session: Session, tenant_id: UUID, pages: int, charged_period: date | None
) -> int:
    """Give back pages charged for a file deleted in the same quota month.

    Runs inside the caller's transaction (the one deleting the file), so the
    refund and the delete commit or roll back together. Returns the pages
    refunded: 0 when the upload was charged in an earlier month, or the
    counter has already rolled to a new month.
    """
    if pages < 1 or charged_period is None:
        return 0
    period = current_quota_period()
    if charged_period != period:
        return 0
    row = session.execute(
        text(
            """
            UPDATE tenants
               SET schematic_pages_used = GREATEST(0, schematic_pages_used - :pages)
             WHERE id = :id
               AND ai_quota_period_start >= :period
         RETURNING schematic_pages_used
            """
        ),
        {"id": tenant_id, "pages": pages, "period": period},
    ).first()
    return pages if row is not None else 0


def schematic_pages_used(session: Session, tenant_id: UUID) -> int:
    """Pages used this quota month (0 if the counter is from an earlier month)."""
    row = session.execute(
        text("SELECT schematic_pages_used, ai_quota_period_start FROM tenants WHERE id = :id"),
        {"id": tenant_id},
    ).first()
    if row is None:
        return 0
    used, start = row
    # The watermark is any day in the current month once it has rolled.
    return int(used or 0) if start is not None and start >= current_quota_period() else 0


def member_count(session: Session, tenant_id: UUID) -> int:
    row = session.execute(
        text("SELECT COUNT(*) FROM tenant_memberships WHERE tenant_id = :id"),
        {"id": tenant_id},
    ).scalar_one()
    return int(row)


def seats_available(tenant: Tenant, current_members: int) -> bool:
    q = quotas_for(
        effective_tier(
            tenant.subscription_tier,
            billing_status=tenant.stripe_subscription_status,
            billing_grace_until=tenant.billing_grace_until,
        )
    )
    return current_members < q.seats
