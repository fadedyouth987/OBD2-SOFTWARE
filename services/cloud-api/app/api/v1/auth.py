"""Edge lease, pairing, JWKS, and (dev-only) session issuance."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from uuid import UUID, uuid4

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
from app.services.billing import entitlement_for, maybe_expire_grace
from app.services.flags import immo_feature_enabled
from app.services.identity import (
    IdentityError,
    authenticate,
    check_password_policy,
    hash_password,
    normalize_email,
    user_by_email,
    user_profile,
    workspaces_for,
)
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


class SignupRequest(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)
    display_name: str = Field(default="", max_length=120)
    workshop_name: str = Field(default="", max_length=200)
    # Joining a workshop from an invite link instead of creating a new one.
    invite_token: str | None = Field(default=None, min_length=20, max_length=200)


class LoginRequest(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(max_length=256)
    tenant_id: UUID | None = None


class SwitchWorkspaceRequest(BaseModel):
    tenant_id: UUID


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


def _issue(tenant_id: UUID, user_id: UUID) -> dict:
    try:
        return issue_session_jwt(str(tenant_id), str(user_id))
    except SigningKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc


def _workspace_list(user_id: UUID) -> list[dict]:
    return [
        {"tenant_id": str(w.tenant_id), "name": w.name, "role": w.role, "tier": w.tier}
        for w in workspaces_for(user_id)
    ]


@router.post("/signup", status_code=201)
def signup(req: SignupRequest) -> dict:
    """Create an account and its workshop (the new user is the Owner)."""
    try:
        email = normalize_email(req.email)
        check_password_policy(req.password)
    except IdentityError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    if user_by_email(email) is not None:
        raise HTTPException(
            status_code=409, detail="An account with this email already exists. Sign in instead."
        )
    display = req.display_name.strip() or email.split("@", 1)[0]
    if req.invite_token:
        return _signup_from_invite(req, email, display)
    workshop = req.workshop_name.strip() or f"{display}'s workshop"
    tenant_id = uuid4()
    user_id = uuid4()
    try:
        with tenant_session(tenant_id) as session:
            session.add(
                User(
                    id=user_id,
                    email=email,
                    display_name=display[:120],
                    password_hash=hash_password(req.password),
                    # Signing up signs you in.
                    last_login_at=datetime.now(UTC),
                )
            )
            session.flush()
            session.add(Tenant(id=tenant_id, name=workshop[:200]))
            session.flush()
            session.add(
                TenantMembership(tenant_id=tenant_id, user_id=user_id, role=MembershipRole.OWNER)
            )
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409, detail="An account with this email already exists. Sign in instead."
        ) from exc
    inc("auth_signup")
    return {
        **_issue(tenant_id, user_id),
        "tenant_id": str(tenant_id),
        "user_id": str(user_id),
        "workspaces": _workspace_list(user_id),
    }


def _signup_from_invite(req: SignupRequest, email: str, display: str) -> dict:
    """Create the account straight into the inviting workshop (no workshop of its own)."""
    from app.api.v1.team import join_with_invite

    user_id = uuid4()
    user = User(
        id=user_id,
        email=email,
        display_name=display[:120],
        password_hash=hash_password(req.password),
        last_login_at=datetime.now(UTC),
    )
    try:
        tenant_id = join_with_invite(req.invite_token or "", user_id, email, new_user=user)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409, detail="An account with this email already exists. Sign in instead."
        ) from exc
    inc("auth_signup")
    return {
        **_issue(tenant_id, user_id),
        "tenant_id": str(tenant_id),
        "user_id": str(user_id),
        "workspaces": _workspace_list(user_id),
    }


@router.post("/login")
def login(req: LoginRequest) -> dict:
    """Email + password sign-in. Picks the requested workspace or the first one."""
    try:
        user_id = authenticate(req.email, req.password)
    except IdentityError as exc:
        inc("auth_login_failed")
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    spaces = workspaces_for(user_id)
    if not spaces:
        raise HTTPException(
            status_code=403, detail="This account is not a member of any workshop yet"
        )
    chosen = next((w for w in spaces if w.tenant_id == req.tenant_id), spaces[0])
    inc("auth_login")
    return {
        **_issue(chosen.tenant_id, user_id),
        "tenant_id": str(chosen.tenant_id),
        "user_id": str(user_id),
        "workspaces": _workspace_list(user_id),
    }


@router.post("/switch-workspace")
def switch_workspace(req: SwitchWorkspaceRequest, principal: RequirePrincipal) -> dict:
    spaces = workspaces_for(principal.user_id)
    if not any(w.tenant_id == req.tenant_id for w in spaces):
        raise HTTPException(status_code=403, detail="You are not a member of that workshop")
    return {
        **_issue(req.tenant_id, principal.user_id),
        "tenant_id": str(req.tenant_id),
        "user_id": str(principal.user_id),
        "workspaces": _workspace_list(principal.user_id),
    }


@router.get("/me")
def me(principal: RequirePrincipal) -> dict:
    """Everything the app shell shows: who, which workshop, plan, usage, entitlements."""
    profile = user_profile(principal.user_id) or {}
    with tenant_session(principal.tenant_id) as session:
        tenant = session.get(Tenant, principal.tenant_id)
        if tenant is None:
            raise HTTPException(status_code=401, detail="Unknown tenant")
        maybe_expire_grace(session, tenant)
        ent = entitlement_for(tenant)
        usage = {
            "ai_diagnoses_used": int(tenant.ai_diagnoses_used or 0),
            "schematic_pages_used": int(tenant.schematic_pages_used or 0),
            "quota_period_start": (
                tenant.ai_quota_period_start.isoformat() if tenant.ai_quota_period_start else None
            ),
            "quota_timezone": "Australia/Adelaide",
        }
    last_login = profile.get("last_login_at")
    return {
        "user": {
            "id": str(principal.user_id),
            "email": profile.get("email"),
            "display_name": profile.get("display_name"),
            "last_login_at": last_login.isoformat() if last_login else None,
        },
        "workspace": {
            "tenant_id": str(principal.tenant_id),
            "name": principal.tenant_name,
            "role": principal.role.value,
            "aasra_verified": principal.aasra_verified,
        },
        "workspaces": _workspace_list(principal.user_id),
        "entitlements": ent,
        "usage": usage,
        "immo_feature_enabled": immo_feature_enabled(),
        "dev_login_enabled": _dev_login_enabled(),
    }
