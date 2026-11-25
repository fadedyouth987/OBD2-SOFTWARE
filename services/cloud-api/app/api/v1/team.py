"""Team: members, sites and invites, with the plan's seat and site caps.

Only the workshop Owner manages the team. Open invites hold a seat until
they're accepted, revoked or expire, so a workshop can't invite past its cap.
Invite tokens are random, shown once, and stored only as a SHA-256 hash.
There's no mail service yet: the Owner copies the invite link and sends it.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text

from app.api.deps import Principal, RequirePrincipal
from app.config import get_settings
from app.db.models import MembershipRole, Site, Tenant, TenantInvite, TenantMembership, User
from app.db.session import tenant_session
from app.observability.metrics import inc
from app.services.billing import effective_tier, quotas_for
from app.services.identity import IdentityError, normalize_email, owner_engine, user_profile

router = APIRouter(prefix="/api/v1/team", tags=["team"])

INVITE_TTL = timedelta(days=7)
DEFAULT_SITE = "Main site"
InviteRole = Literal["LEAD_TECH", "TECH"]


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def invite_url(token: str) -> str:
    return f"{get_settings().public_app_url.rstrip('/')}/join?token={token}"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _now() -> datetime:
    return datetime.now(UTC)


def _require_owner(principal: Principal) -> None:
    if principal.role != MembershipRole.OWNER:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the workshop owner can manage the team",
        )


def _open_invites(session, tenant_id: UUID, now: datetime) -> list[TenantInvite]:
    return list(
        session.scalars(
            select(TenantInvite)
            .where(
                TenantInvite.tenant_id == tenant_id,
                TenantInvite.accepted_at.is_(None),
                TenantInvite.revoked_at.is_(None),
            )
            .order_by(TenantInvite.created_at)
        )
    )


def _member_count(session, tenant_id: UUID) -> int:
    return int(
        session.scalar(
            select(func.count())
            .select_from(TenantMembership)
            .where(TenantMembership.tenant_id == tenant_id)
        )
        or 0
    )


def _lock_tenant(session, tenant_id: UUID) -> Tenant:
    """Serialise cap checks for one workshop (two invites at once can't both take the last seat)."""
    tenant = session.scalars(select(Tenant).where(Tenant.id == tenant_id).with_for_update()).one()
    return tenant


def ensure_default_site(session, tenant_id: UUID) -> list[Site]:
    sites = list(
        session.scalars(select(Site).where(Site.tenant_id == tenant_id).order_by(Site.created_at))
    )
    if sites:
        return sites
    site = Site(tenant_id=tenant_id, name=DEFAULT_SITE)
    session.add(site)
    session.flush()
    session.execute(
        text("UPDATE tenant_memberships SET site_id = :s WHERE tenant_id = :t AND site_id IS NULL"),
        {"s": site.id, "t": tenant_id},
    )
    return [site]


def _invite_json(i: TenantInvite, now: datetime) -> dict:
    return {
        "id": str(i.id),
        "email": i.email,
        "role": i.role.value,
        "site_id": str(i.site_id) if i.site_id else None,
        "created_at": i.created_at.isoformat() if i.created_at else None,
        "expires_at": i.expires_at.isoformat(),
        "expired": i.expires_at <= now,
    }


@router.get("")
def get_team(principal: RequirePrincipal) -> dict:
    now = _now()
    q = quotas_for(principal.tier)
    with tenant_session(principal.tenant_id) as session:
        sites = ensure_default_site(session, principal.tenant_id)
        rows = session.execute(
            select(TenantMembership, User)
            .join(User, User.id == TenantMembership.user_id)
            .where(TenantMembership.tenant_id == principal.tenant_id)
            .order_by(TenantMembership.created_at)
        ).all()
        invites = _open_invites(session, principal.tenant_id, now)
        live_invites = [i for i in invites if i.expires_at > now]
        per_site: dict[UUID | None, int] = {}
        for m, _ in rows:
            per_site[m.site_id] = per_site.get(m.site_id, 0) + 1
        return {
            "can_manage": principal.role == MembershipRole.OWNER,
            "seats": {"used": len(rows), "pending": len(live_invites), "limit": q.seats},
            "sites_cap": {"used": len(sites), "limit": q.sites},
            "members": [
                {
                    "user_id": str(u.id),
                    "email": u.email,
                    "display_name": u.display_name or "",
                    "role": m.role.value,
                    "site_id": str(m.site_id) if m.site_id else None,
                    "joined_at": m.created_at.isoformat() if m.created_at else None,
                    "you": u.id == principal.user_id,
                }
                for m, u in rows
            ],
            "invites": [_invite_json(i, now) for i in invites],
            "sites": [
                {"id": str(s.id), "name": s.name, "members": per_site.get(s.id, 0)} for s in sites
            ],
        }


class InviteRequest(BaseModel):
    email: str = Field(max_length=254)
    role: InviteRole = "TECH"
    site_id: UUID | None = None


@router.post("/invites", status_code=201)
def create_invite(req: InviteRequest, principal: RequirePrincipal) -> dict:
    _require_owner(principal)
    try:
        email = normalize_email(req.email)
    except IdentityError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    now = _now()
    q = quotas_for(principal.tier)
    with tenant_session(principal.tenant_id) as session:
        _lock_tenant(session, principal.tenant_id)
        if req.site_id is not None and session.get(Site, req.site_id) is None:
            raise HTTPException(status_code=422, detail="That site doesn't exist")
        already = session.execute(
            select(User.id)
            .join(TenantMembership, TenantMembership.user_id == User.id)
            .where(TenantMembership.tenant_id == principal.tenant_id, User.email == email)
        ).first()
        if already:
            raise HTTPException(status_code=409, detail="They're already on your team")
        invites = _open_invites(session, principal.tenant_id, now)
        for i in invites:
            if i.email == email:
                if i.expires_at > now:
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            "There's already an open invite for that email. "
                            "Revoke it to send a new one."
                        ),
                    )
                i.revoked_at = now  # An expired invite is replaced.
        session.flush()
        held = _member_count(session, principal.tenant_id) + sum(
            1 for i in invites if i.expires_at > now and i.revoked_at is None
        )
        if held >= q.seats:
            raise HTTPException(
                status_code=402,
                detail=f"Your plan includes {_plural(q.seats, 'seat')}, and they're all "
                "taken or invited. Upgrade, or revoke an invite or remove a member first.",
            )
        token = secrets.token_urlsafe(32)
        invite = TenantInvite(
            tenant_id=principal.tenant_id,
            email=email,
            role=MembershipRole(req.role),
            site_id=req.site_id,
            token_hash=hash_token(token),
            invited_by=principal.user_id,
            expires_at=now + INVITE_TTL,
        )
        session.add(invite)
        session.flush()
        session.refresh(invite)
        inc("team_invite_created")
        return {
            "invite": _invite_json(invite, now),
            "token": token,
            "invite_url": invite_url(token),
        }


@router.delete("/invites/{invite_id}", status_code=204)
def revoke_invite(invite_id: UUID, principal: RequirePrincipal) -> None:
    _require_owner(principal)
    with tenant_session(principal.tenant_id) as session:
        invite = session.get(TenantInvite, invite_id)
        if invite is None or invite.accepted_at is not None or invite.revoked_at is not None:
            raise HTTPException(status_code=404, detail="No open invite with that id")
        invite.revoked_at = _now()


class MemberUpdate(BaseModel):
    role: InviteRole | None = None
    site_id: UUID | None = None
    clear_site: bool = False


@router.patch("/members/{user_id}")
def update_member(user_id: UUID, req: MemberUpdate, principal: RequirePrincipal) -> dict:
    _require_owner(principal)
    with tenant_session(principal.tenant_id) as session:
        m = session.get(TenantMembership, (principal.tenant_id, user_id))
        if m is None:
            raise HTTPException(status_code=404, detail="Not a member of this workshop")
        if req.role is not None:
            if m.role == MembershipRole.OWNER:
                raise HTTPException(
                    status_code=409, detail="The owner's role can't be changed here"
                )
            m.role = MembershipRole(req.role)
        if req.clear_site:
            m.site_id = None
        elif req.site_id is not None:
            if session.get(Site, req.site_id) is None:
                raise HTTPException(status_code=422, detail="That site doesn't exist")
            m.site_id = req.site_id
        return {
            "user_id": str(user_id),
            "role": m.role.value,
            "site_id": str(m.site_id) if m.site_id else None,
        }


@router.delete("/members/{user_id}", status_code=204)
def remove_member(user_id: UUID, principal: RequirePrincipal) -> None:
    _require_owner(principal)
    if user_id == principal.user_id:
        raise HTTPException(status_code=409, detail="You can't remove yourself as the owner")
    with tenant_session(principal.tenant_id) as session:
        m = session.get(TenantMembership, (principal.tenant_id, user_id))
        if m is None:
            raise HTTPException(status_code=404, detail="Not a member of this workshop")
        if m.role == MembershipRole.OWNER:
            raise HTTPException(status_code=409, detail="The owner can't be removed")
        session.delete(m)
    inc("team_member_removed")


class SiteRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)


def _site_name(raw: str) -> str:
    name = " ".join(raw.split())
    if not name:
        raise HTTPException(status_code=422, detail="Give the site a name")
    return name


@router.post("/sites", status_code=201)
def create_site(req: SiteRequest, principal: RequirePrincipal) -> dict:
    _require_owner(principal)
    name = _site_name(req.name)
    q = quotas_for(principal.tier)
    with tenant_session(principal.tenant_id) as session:
        _lock_tenant(session, principal.tenant_id)
        sites = ensure_default_site(session, principal.tenant_id)
        if len(sites) >= q.sites:
            raise HTTPException(
                status_code=402,
                detail=f"Your plan includes {_plural(q.sites, 'site')}. Fleet covers up to 3.",
            )
        if any(s.name.lower() == name.lower() for s in sites):
            raise HTTPException(status_code=409, detail="You already have a site with that name")
        site = Site(tenant_id=principal.tenant_id, name=name)
        session.add(site)
        session.flush()
        return {"id": str(site.id), "name": site.name, "members": 0}


@router.patch("/sites/{site_id}")
def rename_site(site_id: UUID, req: SiteRequest, principal: RequirePrincipal) -> dict:
    _require_owner(principal)
    name = _site_name(req.name)
    with tenant_session(principal.tenant_id) as session:
        site = session.get(Site, site_id)
        if site is None:
            raise HTTPException(status_code=404, detail="No site with that id")
        clash = session.scalar(
            select(Site.id).where(
                Site.tenant_id == principal.tenant_id,
                func.lower(Site.name) == name.lower(),
                Site.id != site_id,
            )
        )
        if clash:
            raise HTTPException(status_code=409, detail="You already have a site with that name")
        site.name = name
        return {"id": str(site.id), "name": site.name}


@router.delete("/sites/{site_id}", status_code=204)
def delete_site(site_id: UUID, principal: RequirePrincipal) -> None:
    _require_owner(principal)
    with tenant_session(principal.tenant_id) as session:
        site = session.get(Site, site_id)
        if site is None:
            raise HTTPException(status_code=404, detail="No site with that id")
        count = session.scalar(
            select(func.count()).select_from(Site).where(Site.tenant_id == principal.tenant_id)
        )
        if (count or 0) <= 1:
            raise HTTPException(status_code=409, detail="A workshop needs at least one site")
        session.delete(site)  # Members and invites at this site keep working, with no site set.


# --- accepting an invite ---------------------------------------------------------


def find_invite(token: str) -> dict | None:
    """Cross-workshop lookup by token hash (owner role: the invitee isn't a member yet)."""
    with owner_engine().connect() as conn:
        row = (
            conn.execute(
                text(
                    """
                    SELECT i.id, i.tenant_id, i.email, i.role::text AS role, i.site_id,
                           i.expires_at, i.accepted_at, i.revoked_at, t.name AS workshop
                    FROM tenant_invites i JOIN tenants t ON t.id = i.tenant_id
                    WHERE i.token_hash = :h
                    """
                ),
                {"h": hash_token(token)},
            )
            .mappings()
            .one_or_none()
        )
    return dict(row) if row else None


def invite_state(inv: dict, now: datetime) -> str:
    if inv["accepted_at"] is not None:
        return "used"
    if inv["revoked_at"] is not None:
        return "revoked"
    if inv["expires_at"] <= now:
        return "expired"
    return "open"


_STATE_TEXT = {
    "used": "This invite has already been used.",
    "revoked": "This invite was cancelled by the workshop.",
    "expired": "This invite has expired. Ask the workshop for a new one.",
}


@router.get("/invites/lookup")
def lookup_invite(token: str = Query(min_length=20, max_length=200)) -> dict:
    inv = find_invite(token)
    if inv is None:
        raise HTTPException(status_code=404, detail="That invite link isn't valid")
    return {
        "workshop": inv["workshop"],
        "email": inv["email"],
        "role": inv["role"],
        "state": invite_state(inv, _now()),
    }


def join_with_invite(token: str, user_id: UUID, email: str, new_user: User | None = None) -> UUID:
    """Add ``user_id`` to the inviting workshop and return its id. With ``new_user``
    (sign-up from an invite) the account is created in the same transaction."""
    now = _now()
    inv = find_invite(token)
    if inv is None:
        raise HTTPException(status_code=404, detail="That invite link isn't valid")
    state = invite_state(inv, now)
    if state != "open":
        raise HTTPException(status_code=410, detail=_STATE_TEXT[state])
    if inv["email"] != email:
        raise HTTPException(
            status_code=403,
            detail=f"This invite is for {inv['email']}. Sign in with that email to accept it.",
        )
    tenant_id: UUID = inv["tenant_id"]
    with tenant_session(tenant_id) as session:
        tenant = _lock_tenant(session, tenant_id)
        invite = session.get(TenantInvite, inv["id"])
        if invite is None or invite.accepted_at is not None or invite.revoked_at is not None:
            raise HTTPException(status_code=410, detail="This invite is no longer open.")
        if new_user is not None:
            session.add(new_user)
            session.flush()
        if session.get(TenantMembership, (tenant_id, user_id)) is None:
            q = quotas_for(
                effective_tier(
                    tenant.subscription_tier,
                    billing_status=tenant.stripe_subscription_status,
                    billing_grace_until=tenant.billing_grace_until,
                )
            )
            if _member_count(session, tenant_id) >= q.seats:
                raise HTTPException(
                    status_code=402,
                    detail=(
                        "That workshop has no free seats right now. "
                        "Ask the owner to check their plan."
                    ),
                )
            session.add(
                TenantMembership(
                    tenant_id=tenant_id, user_id=user_id, role=invite.role, site_id=invite.site_id
                )
            )
        invite.accepted_at = now
        invite.accepted_by = user_id
    inc("team_invite_accepted")
    return tenant_id


class AcceptRequest(BaseModel):
    token: str = Field(min_length=20, max_length=200)


@router.post("/invites/accept")
def accept_invite(req: AcceptRequest, principal: RequirePrincipal) -> dict:
    from app.api.v1.auth import _issue, _workspace_list

    profile = user_profile(principal.user_id) or {}
    tenant_id = join_with_invite(
        req.token, principal.user_id, str(profile.get("email", "")).lower()
    )
    return {
        **_issue(tenant_id, principal.user_id),
        "tenant_id": str(tenant_id),
        "user_id": str(principal.user_id),
        "workspaces": _workspace_list(principal.user_id),
    }
