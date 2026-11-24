"""Stripe subscription metering, tier entitlements & webhook verification (Task 2.3, A-CEO-3)."""

from __future__ import annotations

import os
from datetime import date
from typing import Any
from uuid import UUID

import stripe
from fastapi import APIRouter, Header, HTTPException, Request, status

from app.api.deps import RequirePrincipal
from app.db.models import StripeEvent, SubscriptionTier, Tenant
from app.db.session import tenant_session
from app.observability.metrics import inc
from app.services.signing import normalize_tier

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])

TIER_QUOTAS: dict[str, dict[str, Any]] = {
    "COMMUNITY": {"price_aud_month": 0, "ai_diagnoses_per_month": 5, "retention_days": 30},
    "PRO": {"price_aud_month": 39, "ai_diagnoses_per_month": 100, "retention_days": 365},
    "WORKSHOP": {"price_aud_month": 89, "ai_diagnoses_per_month": 1000, "retention_days": 730},
    # Price-list only; stored and enforced as WORKSHOP (DB enum has no FLEET).
    "FLEET": {"price_aud_month": 249, "ai_diagnoses_per_month": 1000, "retention_days": 730},
}


def quota_limit(tier: str | SubscriptionTier) -> int:
    key = tier.value if isinstance(tier, SubscriptionTier) else normalize_tier(str(tier))
    return int(TIER_QUOTAS.get(key, TIER_QUOTAS["COMMUNITY"])["ai_diagnoses_per_month"])


def ensure_quota_period(tenant: Tenant) -> None:
    """Reset the lifetime-looking counter at the start of each calendar month."""
    today = date.today()
    start = tenant.ai_quota_period_start
    if start is None or start.year != today.year or start.month != today.month:
        tenant.ai_diagnoses_used = 0
        tenant.ai_quota_period_start = date(today.year, today.month, 1)


def charge_ai_quota(tenant_id: UUID) -> tuple[bool, int, int]:
    """Atomically charge one AI diagnosis. Returns (charged, used, limit)."""
    with tenant_session(tenant_id) as session:
        tenant = session.get(Tenant, tenant_id)
        if tenant is None:
            raise HTTPException(status_code=401, detail="Unknown tenant")
        ensure_quota_period(tenant)
        limit = quota_limit(tenant.subscription_tier)
        if tenant.ai_diagnoses_used >= limit:
            return False, tenant.ai_diagnoses_used, limit
        tenant.ai_diagnoses_used += 1
        return True, tenant.ai_diagnoses_used, limit


def _webhook_secret() -> str:
    return os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()


def _event_attr(event: Any, name: str, default: Any = None) -> Any:
    if isinstance(event, dict):
        return event.get(name, default)
    return getattr(event, name, default)


@router.get("/tiers")
def get_tiers() -> dict[str, Any]:
    return {"currency": "AUD", "gst_inclusive": True, "tiers": TIER_QUOTAS}


@router.get("/tenants/{tenant_id}")
def get_tenant_billing(tenant_id: str, principal: RequirePrincipal) -> dict[str, Any]:
    try:
        requested = UUID(tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Unknown tenant") from exc
    if requested != principal.tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="Unknown tenant")
        ensure_quota_period(tenant)
        used = tenant.ai_diagnoses_used
        tier = tenant.subscription_tier.value
    return {
        "tenant_id": str(principal.tenant_id),
        "tier": tier,
        "quotas": TIER_QUOTAS[tier],
        "ai_diagnoses_used": used,
        "ai_diagnoses_remaining": max(0, quota_limit(tier) - used),
    }


@router.post("/stripe/webhook")
async def stripe_webhook(
    request: Request, stripe_signature: str = Header(default="", alias="Stripe-Signature")
) -> dict[str, Any]:
    secret = _webhook_secret()
    if not secret:
        inc("stripe_webhook_rejected")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="STRIPE_WEBHOOK_SECRET is not configured",
        )
    body = await request.body()
    try:
        event = stripe.Webhook.construct_event(body, stripe_signature, secret)
    except Exception:
        inc("stripe_webhook_rejected")
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature") from None

    event_id = str(_event_attr(event, "id") or "")
    event_type = str(_event_attr(event, "type") or "")
    data = _event_attr(event, "data")
    obj = _event_attr(data, "object") if data is not None else None
    meta = _event_attr(obj, "metadata") if obj is not None else None
    if meta is None:
        meta = {}
    elif not isinstance(meta, dict):
        to_dict = getattr(meta, "to_dict", None)
        meta = to_dict() if callable(to_dict) else dict(meta)
    raw_tenant = str(meta.get("tenant_id", "")).strip()
    raw_tier = str(meta.get("tier", "")).strip().upper()
    try:
        tenant_id = UUID(raw_tenant) if raw_tenant else None
    except ValueError:
        tenant_id = None

    if not event_id or tenant_id is None:
        inc("stripe_webhook_processed")
        return {
            "status": "processed",
            "event_id": event_id or None,
            "tenant_updated": None,
            "active_tier": None,
        }

    try:
        with tenant_session(tenant_id) as session:
            existing = session.get(StripeEvent, event_id)
            if existing is not None:
                tenant = session.get(Tenant, tenant_id)
                return {
                    "status": "duplicate_ignored",
                    "event_id": event_id,
                    "tenant_updated": str(tenant_id),
                    "active_tier": tenant.subscription_tier.value if tenant else None,
                }
            session.add(
                StripeEvent(
                    event_id=event_id,
                    tenant_id=tenant_id,
                    event_type=event_type,
                    payload={"type": event_type, "metadata": {"tier": raw_tier}},
                )
            )
            tenant = session.get(Tenant, tenant_id)
            active_tier = tenant.subscription_tier.value if tenant else None
            if tenant is not None and raw_tier in TIER_QUOTAS:
                if event_type == "customer.subscription.deleted":
                    tenant.subscription_tier = SubscriptionTier.COMMUNITY
                else:
                    tenant.subscription_tier = SubscriptionTier(normalize_tier(raw_tier))
                active_tier = tenant.subscription_tier.value
    except Exception:
        # Unknown tenant (FK) or identity store blip: acknowledge without applying.
        inc("stripe_webhook_processed")
        return {
            "status": "processed",
            "event_id": event_id,
            "tenant_updated": None,
            "active_tier": None,
        }

    inc("stripe_webhook_processed")
    return {
        "status": "processed",
        "event_id": event_id,
        "tenant_updated": str(tenant_id),
        "active_tier": active_tier,
    }
