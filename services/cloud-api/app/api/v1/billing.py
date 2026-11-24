"""Stripe subscription metering, tier entitlements & webhook verification (Task 2.3, A-CEO-3)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request

from app.observability.metrics import inc

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])
_PROCESSED_STRIPE_EVENTS: set[str] = set()
_TENANT_PLANS: dict[str, dict[str, Any]] = {}

TIER_QUOTAS: dict[str, dict[str, Any]] = {
    "COMMUNITY": {"price_aud_month": 0, "ai_diagnoses_per_month": 5, "retention_days": 30},
    "PRO": {"price_aud_month": 39, "ai_diagnoses_per_month": 100, "retention_days": 365},
    "WORKSHOP": {"price_aud_month": 89, "ai_diagnoses_per_month": 1000, "retention_days": 730},
    "FLEET": {"price_aud_month": 249, "ai_diagnoses_per_month": 5000, "retention_days": 1095},
}


def _billing_state_file() -> Path:
    base = Path(os.environ.get("CLOUD_STATE_DIR", "/tmp/rootcause_cloud_state"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "billing_tenants.json"


def _load_billing_state() -> None:
    p = _billing_state_file()
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            _PROCESSED_STRIPE_EVENTS.update(data.get("events", []))
            _TENANT_PLANS.update(data.get("tenants", {}))
        except Exception:
            pass


def _save_billing_state() -> None:
    try:
        _billing_state_file().write_text(
            json.dumps(
                {"events": sorted(_PROCESSED_STRIPE_EVENTS), "tenants": _TENANT_PLANS},
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


_load_billing_state()


def get_tenant_tier(tenant_id: str, default: str = "COMMUNITY") -> str:
    rec = _TENANT_PLANS.get(tenant_id)
    if rec and rec.get("status") == "active":
        return str(rec.get("tier", default)).upper()
    return default.upper()


def verify_stripe_signature(payload: bytes, sig_header: str, secret: str) -> bool:
    expected = hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig_header.strip())


@router.get("/tiers")
def get_tiers() -> dict[str, Any]:
    return {"currency": "AUD", "gst_inclusive": True, "tiers": TIER_QUOTAS}


@router.get("/tenants/{tenant_id}")
def get_tenant_billing(tenant_id: str) -> dict[str, Any]:
    tier = get_tenant_tier(tenant_id)
    return {
        "tenant_id": tenant_id,
        "tier": tier,
        "quotas": TIER_QUOTAS.get(tier, TIER_QUOTAS["COMMUNITY"]),
        "record": _TENANT_PLANS.get(tenant_id, {"status": "free_default"}),
    }


@router.post("/stripe/webhook")
async def stripe_webhook(request: Request, stripe_signature: str = Header(default="")) -> dict[str, Any]:
    body = await request.body()
    secret = os.environ.get("STRIPE_WEBHOOK_SECRET", "whsec_dev_test")
    if not stripe_signature or not verify_stripe_signature(body, stripe_signature, secret):
        inc("stripe_webhook_rejected")
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature")

    data = await request.json()
    event_id = str(data.get("id", ""))
    if event_id in _PROCESSED_STRIPE_EVENTS:
        return {"status": "duplicate_ignored", "event_id": event_id}
    _PROCESSED_STRIPE_EVENTS.add(event_id)

    event_type = str(data.get("type", ""))
    obj = data.get("data", {}).get("object", {}) if isinstance(data.get("data"), dict) else {}
    meta = obj.get("metadata", {}) if isinstance(obj, dict) else {}
    tenant_id = str(meta.get("tenant_id", "")).strip()
    tier = str(meta.get("tier", "")).strip().upper()
    if tenant_id and tier in TIER_QUOTAS:
        status = "canceled" if event_type == "customer.subscription.deleted" else "active"
        _TENANT_PLANS[tenant_id] = {
            "tier": "COMMUNITY" if status == "canceled" else tier,
            "status": status,
            "last_event_id": event_id,
            "source": str(meta.get("source", "stripe")),
        }

    _save_billing_state()
    inc("stripe_webhook_processed")
    return {
        "status": "processed",
        "event_id": event_id,
        "tenant_updated": tenant_id or None,
        "active_tier": get_tenant_tier(tenant_id) if tenant_id else None,
    }
