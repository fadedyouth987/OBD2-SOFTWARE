"""Billing catalog, Stripe Checkout / Customer Portal, and webhooks."""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import stripe
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.api.deps import Principal, RequirePrincipal
from app.config import get_settings
from app.db.models import SubscriptionTier, Tenant
from app.db.session import tenant_session
from app.observability.metrics import count
from app.services.billing import (
    ACTIONABLE_EVENTS,
    IMMO_ELIGIBLE,
    TRIAL_DAYS,
    BillingApplyError,
    apply_stripe_event,
    catalog_public,
    charge_ai_quota,
    charge_schematic_pages,
    entitlement_for,
    maybe_expire_grace,
    offered_tiers,
    resolve_event_tenant_id,
)
from app.services.permissions import Permission, require

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])
log = logging.getLogger(__name__)

# Subscription statuses after which a new Checkout is fine; anything else still bills.
ENDED_SUBSCRIPTION_STATUSES = frozenset({"none", "canceled", "incomplete_expired", "unpaid"})

# Re-exported so existing imports (`from app.api.v1.billing import charge_ai_quota`) keep working.
__all__ = [
    "router",
    "charge_ai_quota",
    "charge_schematic_pages",
    "require_owner",
]


def require_owner(principal: Principal) -> None:
    """Billing and plan changes are the Owner's alone (lead techs included out)."""
    require(principal, Permission.MANAGE_BILLING)


BILLING_PATH = "/workshop/billing"


def _app_url(path: str | None, default: str) -> str:
    """Absolute URL on our own app. Only same-app paths are accepted, so a
    client can't turn Stripe's redirect into an open redirect."""
    base = get_settings().public_app_url.rstrip("/")
    if not path or not path.startswith("/") or path.startswith("//") or "\\" in path:
        path = default
    return f"{base}{path}"


class CheckoutRequest(BaseModel):
    tier: SubscriptionTier
    interval: str = Field(pattern="^(month|year)$")
    immo_addon: bool = False
    start_trial: bool = False
    # Paths on this app only (e.g. "/workshop/billing?checkout=success").
    success_url: str | None = Field(default=None, max_length=300)
    cancel_url: str | None = Field(default=None, max_length=300)


class PortalRequest(BaseModel):
    return_url: str | None = Field(default=None, max_length=300)


@router.get("/tiers")
def list_tiers() -> dict[str, Any]:
    """Public catalog: names, AUD prices, and included limits."""
    return catalog_public()


@router.get("")
def get_billing(principal: RequirePrincipal) -> dict[str, Any]:
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="Unknown tenant")
        maybe_expire_grace(session, tenant)
        ent = entitlement_for(tenant)
        return {
            **catalog_public(),
            **ent,
            "ai_diagnoses_used": tenant.ai_diagnoses_used,
            "schematic_pages_used": tenant.schematic_pages_used,
            "quota_period_start": (
                tenant.ai_quota_period_start.isoformat() if tenant.ai_quota_period_start else None
            ),
            "quota_timezone": "Australia/Adelaide",
            "has_stripe_customer": bool(tenant.stripe_customer_id),
            "role": principal.role.value,
        }


@router.post("/checkout-session")
def create_checkout_session(req: CheckoutRequest, principal: RequirePrincipal) -> dict[str, Any]:
    require_owner(principal)
    if req.tier == SubscriptionTier.COMMUNITY:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Community is the free default; pick a paid plan to check out",
        )
    if req.tier not in offered_tiers():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"The {req.tier.value.title()} plan isn't offered",
        )
    if req.immo_addon and req.tier not in IMMO_ELIGIBLE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The IMMO add-on is only available on Workshop and Fleet",
        )

    settings = get_settings()
    if not settings.stripe_secret_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe secret key is not configured",
        )
    price_id = settings.price_id_for(req.tier.value, req.interval)
    if not price_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Stripe price ID for {req.tier.value} {req.interval} is not configured",
        )
    line_items = [{"price": price_id, "quantity": 1}]
    if req.immo_addon:
        immo_price = settings.immo_price_id(req.interval)
        if not immo_price:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Stripe price ID for IMMO {req.interval} is not configured",
            )
        line_items.append({"price": immo_price, "quantity": 1})

    trial = False
    if req.start_trial:
        if req.tier != SubscriptionTier.WORKSHOP or req.interval != "month":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="The 14-day trial is a Workshop monthly plan and requires a card",
            )
        with tenant_session(principal.tenant_id) as session:
            tenant = session.get(Tenant, principal.tenant_id)
            if tenant is None:
                raise HTTPException(status_code=404, detail="Unknown tenant")
            if tenant.subscription_tier != SubscriptionTier.COMMUNITY:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="The Workshop trial is for Community workspaces; upgrade instead",
                )
            if tenant.trial_used:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="This workspace has already used its Workshop trial",
                )
        trial = True

    success = _app_url(req.success_url, f"{BILLING_PATH}?checkout=success")
    cancel = _app_url(req.cancel_url, f"{BILLING_PATH}?checkout=cancel")

    customer_id: str | None = None
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is not None:
            customer_id = tenant.stripe_customer_id
            # Review M8: a second Checkout would start a second subscription and bill twice.
            if (
                tenant.stripe_subscription_id
                and (tenant.stripe_subscription_status or "none").lower()
                not in ENDED_SUBSCRIPTION_STATUSES
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={
                        "code": "subscription_exists",
                        "message": (
                            "This workspace already has a subscription. Change plan, "
                            "interval or the IMMO add-on in Manage billing."
                        ),
                    },
                )

    params: dict[str, Any] = {
        "mode": "subscription",
        "line_items": line_items,
        "success_url": success,
        "cancel_url": cancel,
        "client_reference_id": str(principal.tenant_id),
        "subscription_data": {
            "metadata": {"tenant_id": str(principal.tenant_id)},
        },
        "metadata": {"tenant_id": str(principal.tenant_id)},
        # Card is always collected, including for the 14-day Workshop trial.
        "payment_method_collection": "always",
    }
    if trial:
        params["subscription_data"]["trial_period_days"] = TRIAL_DAYS
    if customer_id:
        params["customer"] = customer_id
    else:
        params["customer_creation"] = "always"

    try:
        stripe.api_key = settings.stripe_secret_key
        session_obj = stripe.checkout.Session.create(**params)
    except stripe.StripeError as exc:
        log.exception("Stripe Checkout session create failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Stripe Checkout could not be started",
        ) from exc

    return {"checkout_url": session_obj.url, "checkout_session_id": session_obj.id}


@router.post("/customer-portal")
def create_customer_portal(req: PortalRequest, principal: RequirePrincipal) -> dict[str, Any]:
    require_owner(principal)
    settings = get_settings()
    if not settings.stripe_secret_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe secret key is not configured",
        )
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is None or not tenant.stripe_customer_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This workspace has no Stripe customer yet — start a paid plan first",
            )
        customer_id = tenant.stripe_customer_id
    return_url = _app_url(req.return_url, BILLING_PATH)
    try:
        stripe.api_key = settings.stripe_secret_key
        portal = stripe.billing_portal.Session.create(customer=customer_id, return_url=return_url)
    except stripe.StripeError as exc:
        log.exception("Stripe Customer Portal session create failed")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Stripe Customer Portal could not be started",
        ) from exc
    return {"portal_url": portal.url}


@router.post("/webhook")
@router.post("/stripe/webhook")
async def stripe_webhook(request: Request) -> dict[str, Any]:
    settings = get_settings()
    secret = settings.stripe_webhook_secret
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Stripe webhook secret is not configured",
        )
    payload = await request.body()
    signature = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, signature, secret)
    except ValueError as exc:
        count("obd2_stripe_webhook_failures_total", reason="bad_payload")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid payload"
        ) from exc
    except stripe.SignatureVerificationError as exc:
        count("obd2_stripe_webhook_failures_total", reason="bad_signature")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid Stripe signature"
        ) from exc

    if isinstance(event, stripe.Event):
        event_dict = event.to_dict()
    elif isinstance(event, dict):
        event_dict = event
    else:
        event_dict = dict(event)

    event_type = str(event_dict.get("type") or "")
    event_id = str(event_dict.get("id") or "")
    if event_type not in ACTIONABLE_EVENTS:
        return {"status": "ignored", "event_id": event_id, "type": event_type}

    try:
        tenant_id = resolve_event_tenant_id(event_dict)
    except Exception as exc:
        count("obd2_stripe_webhook_failures_total", reason="tenant_lookup")
        log.exception("tenant lookup failed for Stripe event %s", event_id)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not resolve tenant for Stripe event",
        ) from exc

    if tenant_id is None:
        count("obd2_stripe_webhook_failures_total", reason="unknown_customer")
        # Actionable events must be applied; returning 2xx would drop the retry.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="No tenant found for this Stripe customer or subscription",
        )

    try:
        with tenant_session(UUID(str(tenant_id))) as session:
            result = apply_stripe_event(session, event_dict)
    except BillingApplyError as exc:
        count("obd2_stripe_webhook_failures_total", reason="apply")
        log.exception("Stripe event %s apply failed: %s", event_id, exc)
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    except Exception as exc:
        count("obd2_stripe_webhook_failures_total", reason="apply")
        log.exception("Stripe event %s apply failed", event_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to apply Stripe event",
        ) from exc

    # Compatibility with earlier tests/simulation: "processed" / "duplicate_ignored".
    status_map = {"applied": "processed", "duplicate": "duplicate_ignored"}
    out = dict(result)
    out["status"] = status_map.get(str(out.get("status")), out.get("status"))
    return out
