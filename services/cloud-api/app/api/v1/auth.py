"""Edge lease, pairing, JWKS, and (dev-only) session issuance."""

from __future__ import annotations

import os
from uuid import uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as OrmSession

from app.api.deps import RequirePrincipal
from app.config import get_settings
from app.db.models import MembershipRole, SubscriptionTier, Tenant, TenantMembership, User
from app.db.session import tenant_session
from app.observability.metrics import inc
from app.services.aasra import default_verifier
from app.services.signing import (
    SigningKeyError,
    get_public_jwk,
    issue_edge_lease,
    issue_pairing_jwt,
    issue_session_jwt,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LeaseRequest(BaseModel):
    dongle_id: str | None = None
    # Ignored identity fields: accepted so old clients do not 422, never trusted.
    tenant_id: str | None = None
    user_id: str | None = None
    tier: str | None = None
    aasra_verified: bool | None = None


class PairingRequest(BaseModel):
    origin: str
    tenant_id: str | None = None
    user_id: str | None = None


class DevSessionRequest(BaseModel):
    tenant_name: str = Field(default="Local workshop", max_length=200)
    email: str = "dev@localhost"
    display_name: str = "Local technician"


class DevGrantPlanRequest(BaseModel):
    tier: SubscriptionTier = SubscriptionTier.WORKSHOP
    immo_entitled: bool = False


def _existing_user_id(email: str):
    """Owner-role lookup: RLS hides users until they belong to the current tenant."""
    engine = create_engine(get_settings().migration_database_url)
    try:
        with OrmSession(engine) as session:
            row = session.query(User).filter(User.email == email).one_or_none()
            return None if row is None else row.id
    finally:
        engine.dispose()


def _dev_login_enabled() -> bool:
    return os.environ.get("AUTH_ALLOW_DEV_LOGIN", "").strip().lower() in {"1", "true", "yes"}


def _require_dev_login() -> None:
    if not _dev_login_enabled():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


@router.get("/jwks")
def list_jwks() -> dict:
    try:
        return {"keys": [get_public_jwk()]}
    except SigningKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@router.post("/dev-session")
def create_dev_session(req: DevSessionRequest) -> dict:
    """Issue a session JWT for local development. Disabled unless AUTH_ALLOW_DEV_LOGIN=true."""
    _require_dev_login()
    email = req.email.strip().lower()
    if "@" not in email or email.startswith("@"):
        raise HTTPException(status_code=400, detail="A valid email is required")
    tenant_id = uuid4()
    existing_id = _existing_user_id(email)
    user_id = existing_id or uuid4()
    try:
        with tenant_session(tenant_id) as session:
            if existing_id is None:
                session.add(User(id=user_id, email=email, display_name=req.display_name))
                session.flush()
            session.add(Tenant(id=tenant_id, name=req.tenant_name[:200] or "Local workshop"))
            session.flush()
            session.add(
                TenantMembership(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    role=MembershipRole.OWNER,
                )
            )
    except IntegrityError as exc:
        raise HTTPException(status_code=409, detail="Could not create dev session") from exc
    try:
        token = issue_session_jwt(str(tenant_id), str(user_id))
    except SigningKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    inc("auth_dev_session_issued")
    return {
        **token,
        "tenant_id": str(tenant_id),
        "user_id": str(user_id),
        "tier": SubscriptionTier.COMMUNITY.value,
    }


@router.post("/dev-mark-aasra")
def dev_mark_aasra(principal: RequirePrincipal) -> dict:
    """Mark the current tenant as AASRA-verified. Dev-only, fail-closed otherwise."""
    _require_dev_login()
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=401, detail="Unknown tenant")
        tenant.aasra_verified = True
    inc("auth_dev_aasra_marked")
    return {"tenant_id": str(principal.tenant_id), "aasra_verified": True}


@router.post("/dev-grant-plan")
def dev_grant_plan(req: DevGrantPlanRequest, principal: RequirePrincipal) -> dict:
    """Set the current tenant's plan for local development. Dev-only."""
    _require_dev_login()
    immo = bool(req.immo_entitled) and req.tier in {
        SubscriptionTier.WORKSHOP,
        SubscriptionTier.FLEET,
    }
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=401, detail="Unknown tenant")
        previous = tenant.subscription_tier
        prev_immo = bool(tenant.immo_entitled)
        tenant.subscription_tier = req.tier
        tenant.immo_entitled = immo
        tenant.stripe_subscription_status = (
            "none" if req.tier == SubscriptionTier.COMMUNITY else "active"
        )
        tenant.billing_grace_until = None
        if previous != req.tier or prev_immo != immo:
            tenant.lease_version = int(tenant.lease_version or 0) + 1
        version = int(tenant.lease_version or 0)
    inc("auth_dev_plan_granted")
    return {
        "tenant_id": str(principal.tenant_id),
        "tier": req.tier.value,
        "immo_entitled": immo,
        "lease_version": version,
    }


@router.post("/edge-lease")
def create_edge_lease(req: LeaseRequest, principal: RequirePrincipal) -> dict:
    verified = default_verifier().is_verified(
        principal.tenant_id, tenant_flag=principal.aasra_verified
    )
    try:
        issued = issue_edge_lease(
            str(principal.tenant_id),
            str(principal.user_id),
            tier=principal.tier.value,
            dongle_id=req.dongle_id,
            aasra_verified=verified,
            lease_version=principal.lease_version,
            immo_entitled=principal.immo_entitled,
        )
    except SigningKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    inc("auth_edge_lease_issued")
    return issued


@router.post("/edge-pairing")
def create_edge_pairing(req: PairingRequest, principal: RequirePrincipal) -> dict:
    try:
        issued = issue_pairing_jwt(
            str(principal.tenant_id), str(principal.user_id), origin=req.origin
        )
    except SigningKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    inc("auth_edge_pairing_issued")
    return issued
