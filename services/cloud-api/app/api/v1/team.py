"""Team: members, sites, invites and ownership, with the plan's seat and site caps.

Who can do what is in ``app.services.permissions``: the Owner manages
everything; a lead tech invites technicians and revokes open invites. Open
invites hold a seat until they're accepted, revoked or expire, so a workshop
can't invite past its cap. Invite tokens are random, shown once, and stored only
as a SHA-256 hash. Invites are emailed when email is set up
(``app.services.email``); the copy-link is always available as a fallback.

Ownership changes hands in two steps: the Owner offers it to a member (typing
the workshop name to confirm), and that member accepts or declines. The old
Owner becomes a lead tech. Every team change is written to team_audit_events.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, text

from app.api.deps import Principal, RequirePrincipal
from app.config import get_settings
from app.db.models import (
    MembershipRole,
    OwnershipTransfer,
    Site,
    TeamAuditEvent,
    Tenant,
    TenantInvite,
    TenantMembership,
    User,
)
from app.db.session import owner_engine, tenant_session
from app.observability.metrics import inc
from app.services.billing import effective_tier, quotas_for
from app.services.email import (
    EmailResult,
    email_enabled,
    invite_email,
    ownership_transfer_email,
    send_email,
)
from app.services.identity import IdentityError, normalize_email, user_profile
from app.services.permissions import Permission, can, require

router = APIRouter(prefix="/api/v1/team", tags=["team"])

INVITE_TTL = timedelta(days=7)
TRANSFER_TTL = timedelta(hours=72)
DEFAULT_SITE = "Main site"
AUDIT_LIMIT = 30
InviteRole = Literal["LEAD_TECH", "TECH"]
ROLE_LABEL = {"OWNER": "Owner", "LEAD_TECH": "Lead tech", "TECH": "Technician"}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _app_url(path: str) -> str:
    return f"{get_settings().public_app_url.rstrip('/')}{path}"


def invite_url(token: str) -> str:
    return _app_url(f"/join?token={token}")


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


def _now() -> datetime:
    return datetime.now(UTC)


def _human_date(value: datetime) -> str:
    from zoneinfo import ZoneInfo

    local = value.astimezone(ZoneInfo("Australia/Adelaide"))
    return local.strftime("%-d %b %Y, %-I:%M %p ") + (local.tzname() or "")


def audit(
    session,
    principal: Principal,
    action: str,
    *,
    subject_user_id: UUID | None = None,
    subject_email: str | None = None,
    **detail,
) -> None:
    session.add(
        TeamAuditEvent(
            tenant_id=principal.tenant_id,
            actor_user_id=principal.user_id,
            action=action,
            subject_user_id=subject_user_id,
            subject_email=subject_email,
            detail={k: v for k, v in detail.items() if v is not None},
        )
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


def _expire_stale_transfer(session, tenant_id: UUID, now: datetime) -> OwnershipTransfer | None:
    """The pending offer, after marking it EXPIRED if its time is up."""
    offer = session.scalars(
        select(OwnershipTransfer).where(
            OwnershipTransfer.tenant_id == tenant_id, OwnershipTransfer.status == "PENDING"
        )
    ).one_or_none()
    if offer is not None and offer.expires_at <= now:
        offer.status = "EXPIRED"
        offer.resolved_at = now
        session.add(
            TeamAuditEvent(
                tenant_id=tenant_id,
                actor_user_id=None,
                action="ownership_offer_expired",
                subject_user_id=offer.to_user_id,
                detail={},
            )
        )
        session.flush()
        return None
    return offer


def _audit_json(e: TeamAuditEvent, names: dict[UUID, str]) -> dict:
    return {
        "id": e.id,
        "at": e.at.isoformat() if e.at else None,
        "action": e.action,
        "actor": names.get(e.actor_user_id) if e.actor_user_id else None,
        "subject": (names.get(e.subject_user_id) if e.subject_user_id else None) or e.subject_email,
        "detail": e.detail or {},
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
        names: dict[UUID, str] = {}
        for m, u in rows:
            per_site[m.site_id] = per_site.get(m.site_id, 0) + 1
            names[u.id] = u.display_name or u.email
        offer = _expire_stale_transfer(session, principal.tenant_id, now)
        transfer = None
        if offer is not None and (
            principal.user_id in (offer.from_user_id, offer.to_user_id)
            or can(principal, Permission.VIEW_TEAM_AUDIT)
        ):
            transfer = {
                "id": str(offer.id),
                "from_user_id": str(offer.from_user_id),
                "from_name": names.get(offer.from_user_id, "A former member"),
                "to_user_id": str(offer.to_user_id),
                "to_name": names.get(offer.to_user_id, "A former member"),
                "created_at": offer.created_at.isoformat() if offer.created_at else None,
                "expires_at": offer.expires_at.isoformat(),
                "for_you": offer.to_user_id == principal.user_id,
            }
        history: list[dict] = []
        if can(principal, Permission.VIEW_TEAM_AUDIT):
            events = session.scalars(
                select(TeamAuditEvent)
                .where(TeamAuditEvent.tenant_id == principal.tenant_id)
                .order_by(TeamAuditEvent.at.desc(), TeamAuditEvent.id.desc())
                .limit(AUDIT_LIMIT)
            ).all()
            history = [_audit_json(e, names) for e in events]
        can_invite = can(principal, Permission.INVITE_MEMBERS)
        return {
            # Kept for older clients: true for whoever can manage anything on the team.
            "can_manage": principal.role == MembershipRole.OWNER,
            "abilities": {
                "invite": can_invite,
                "invite_roles": (
                    ["TECH", "LEAD_TECH"]
                    if can(principal, Permission.INVITE_LEAD_TECHS)
                    else (["TECH"] if can_invite else [])
                ),
                "revoke_invites": can_invite,
                "change_roles": can(principal, Permission.MANAGE_ROLES),
                "remove_members": can(principal, Permission.REMOVE_MEMBERS),
                "manage_sites": can(principal, Permission.MANAGE_SITES),
                "transfer_ownership": can(principal, Permission.TRANSFER_OWNERSHIP),
                "view_history": can(principal, Permission.VIEW_TEAM_AUDIT),
            },
            "email_enabled": email_enabled(),
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
            "invites": [_invite_json(i, now) for i in invites] if can_invite else [],
            "sites": [
                {"id": str(s.id), "name": s.name, "members": per_site.get(s.id, 0)} for s in sites
            ],
            "ownership_transfer": transfer,
            "history": history,
        }


class InviteRequest(BaseModel):
    email: str = Field(max_length=254)
    role: InviteRole = "TECH"
    site_id: UUID | None = None


def _email_invite(
    principal: Principal, *, to: str, role: str, expires_at: datetime, token: str
) -> EmailResult:
    inviter = user_profile(principal.user_id) or {}
    return send_email(
        invite_email(
            to=to,
            workshop=principal.tenant_name,
            inviter=str(inviter.get("display_name") or inviter.get("email") or "Your workshop"),
            role_label=ROLE_LABEL.get(role, role),
            url=invite_url(token),
            expires=_human_date(expires_at),
        )
    )


@router.post("/invites", status_code=201)
def create_invite(req: InviteRequest, principal: RequirePrincipal) -> dict:
    require(principal, Permission.INVITE_MEMBERS)
    if req.role == "LEAD_TECH":
        require(principal, Permission.INVITE_LEAD_TECHS)
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
                            "Resend it, or revoke it to send a new one."
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
        audit(session, principal, "invite_created", subject_email=email, role=req.role)
        body = _invite_json(invite, now)
    # Send after the invite is committed, so a slow mail server can't hold the lock.
    result = _email_invite(
        principal,
        to=body["email"],
        role=body["role"],
        expires_at=datetime.fromisoformat(body["expires_at"]),
        token=token,
    )
    inc("team_invite_created")
    return {
        "invite": body,
        "token": token,
        "invite_url": invite_url(token),
        "email": result.as_dict(),
    }


@router.post("/invites/{invite_id}/resend")
def resend_invite(invite_id: UUID, principal: RequirePrincipal) -> dict:
    """New link (the old one stops working), a fresh 7 days, and another email."""
    require(principal, Permission.INVITE_MEMBERS)
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        invite = session.get(TenantInvite, invite_id)
        if invite is None or invite.accepted_at is not None or invite.revoked_at is not None:
            raise HTTPException(status_code=404, detail="No open invite with that id")
        if invite.role == MembershipRole.LEAD_TECH:
            require(principal, Permission.INVITE_LEAD_TECHS)
        token = secrets.token_urlsafe(32)
        invite.token_hash = hash_token(token)
        invite.expires_at = now + INVITE_TTL
        session.flush()
        audit(session, principal, "invite_resent", subject_email=invite.email)
        body = _invite_json(invite, now)
    result = _email_invite(
        principal,
        to=body["email"],
        role=body["role"],
        expires_at=datetime.fromisoformat(body["expires_at"]),
        token=token,
    )
    return {
        "invite": body,
        "token": token,
        "invite_url": invite_url(token),
        "email": result.as_dict(),
    }


@router.delete("/invites/{invite_id}", status_code=204)
def revoke_invite(invite_id: UUID, principal: RequirePrincipal) -> None:
    require(principal, Permission.INVITE_MEMBERS)
    with tenant_session(principal.tenant_id) as session:
        invite = session.get(TenantInvite, invite_id)
        if invite is None or invite.accepted_at is not None or invite.revoked_at is not None:
            raise HTTPException(status_code=404, detail="No open invite with that id")
        if invite.role == MembershipRole.LEAD_TECH:
            require(principal, Permission.INVITE_LEAD_TECHS)
        invite.revoked_at = _now()
        audit(session, principal, "invite_revoked", subject_email=invite.email)


class MemberUpdate(BaseModel):
    role: InviteRole | None = None
    site_id: UUID | None = None
    clear_site: bool = False


@router.patch("/members/{user_id}")
def update_member(user_id: UUID, req: MemberUpdate, principal: RequirePrincipal) -> dict:
    require(principal, Permission.MANAGE_ROLES)
    with tenant_session(principal.tenant_id) as session:
        m = session.get(TenantMembership, (principal.tenant_id, user_id))
        if m is None:
            raise HTTPException(status_code=404, detail="Not a member of this workshop")
        if req.role is not None and req.role != m.role.value:
            if m.role == MembershipRole.OWNER:
                raise HTTPException(
                    status_code=409,
                    detail="The owner's role can't be changed here. Hand over ownership instead.",
                )
            before = m.role.value
            m.role = MembershipRole(req.role)
            audit(
                session,
                principal,
                "member_role_changed",
                subject_user_id=user_id,
                before=before,
                after=req.role,
            )
        if req.clear_site:
            m.site_id = None
            audit(session, principal, "member_site_changed", subject_user_id=user_id, site=None)
        elif req.site_id is not None and req.site_id != m.site_id:
            site = session.get(Site, req.site_id)
            if site is None:
                raise HTTPException(status_code=422, detail="That site doesn't exist")
            m.site_id = req.site_id
            audit(
                session, principal, "member_site_changed", subject_user_id=user_id, site=site.name
            )
        return {
            "user_id": str(user_id),
            "role": m.role.value,
            "site_id": str(m.site_id) if m.site_id else None,
        }


@router.delete("/members/{user_id}", status_code=204)
def remove_member(user_id: UUID, principal: RequirePrincipal) -> None:
    require(principal, Permission.REMOVE_MEMBERS)
    if user_id == principal.user_id:
        raise HTTPException(status_code=409, detail="You can't remove yourself as the owner")
    with tenant_session(principal.tenant_id) as session:
        m = session.get(TenantMembership, (principal.tenant_id, user_id))
        if m is None:
            raise HTTPException(status_code=404, detail="Not a member of this workshop")
        if m.role == MembershipRole.OWNER:
            raise HTTPException(status_code=409, detail="The owner can't be removed")
        offer = _expire_stale_transfer(session, principal.tenant_id, _now())
        if offer is not None and offer.to_user_id == user_id:
            offer.status = "CANCELLED"
            offer.resolved_at = _now()
        user = session.get(User, user_id)
        email = user.email if user else None
        session.delete(m)
        audit(
            session,
            principal,
            "member_removed",
            subject_user_id=None,
            subject_email=email,
            role=m.role.value,
        )
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
    require(principal, Permission.MANAGE_SITES)
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
        audit(session, principal, "site_created", site=name)
        return {"id": str(site.id), "name": site.name, "members": 0}


@router.patch("/sites/{site_id}")
def rename_site(site_id: UUID, req: SiteRequest, principal: RequirePrincipal) -> dict:
    require(principal, Permission.MANAGE_SITES)
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
        before = site.name
        site.name = name
        if before != name:
            audit(session, principal, "site_renamed", before=before, after=name)
        return {"id": str(site.id), "name": site.name}


@router.delete("/sites/{site_id}", status_code=204)
def delete_site(site_id: UUID, principal: RequirePrincipal) -> None:
    require(principal, Permission.MANAGE_SITES)
    with tenant_session(principal.tenant_id) as session:
        site = session.get(Site, site_id)
        if site is None:
            raise HTTPException(status_code=404, detail="No site with that id")
        count = session.scalar(
            select(func.count()).select_from(Site).where(Site.tenant_id == principal.tenant_id)
        )
        if (count or 0) <= 1:
            raise HTTPException(status_code=409, detail="A workshop needs at least one site")
        name = site.name
        session.delete(site)  # Members and invites at this site keep working, with no site set.
        audit(session, principal, "site_deleted", site=name)


# --- ownership --------------------------------------------------------------------


class TransferRequest(BaseModel):
    to_user_id: UUID
    # The Owner types the workshop name, so a mis-click can't start a hand-over.
    confirm_name: str = Field(max_length=200)


def _norm(name: str) -> str:
    return " ".join(name.split()).casefold()


@router.post("/ownership-transfer", status_code=201)
def offer_ownership(req: TransferRequest, principal: RequirePrincipal) -> dict:
    require(principal, Permission.TRANSFER_OWNERSHIP)
    if req.to_user_id == principal.user_id:
        raise HTTPException(status_code=422, detail="You're already the owner")
    if _norm(req.confirm_name) != _norm(principal.tenant_name):
        raise HTTPException(
            status_code=422, detail="Type the workshop name exactly to confirm the hand-over"
        )
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        _lock_tenant(session, principal.tenant_id)
        target = session.get(TenantMembership, (principal.tenant_id, req.to_user_id))
        if target is None:
            raise HTTPException(status_code=404, detail="That person isn't on your team")
        offer = _expire_stale_transfer(session, principal.tenant_id, now)
        if offer is not None:
            raise HTTPException(
                status_code=409,
                detail="There's already a pending hand-over. Cancel it first to offer it again.",
            )
        offer = OwnershipTransfer(
            tenant_id=principal.tenant_id,
            from_user_id=principal.user_id,
            to_user_id=req.to_user_id,
            expires_at=now + TRANSFER_TTL,
            status="PENDING",
        )
        session.add(offer)
        session.flush()
        session.refresh(offer)
        audit(session, principal, "ownership_offered", subject_user_id=req.to_user_id)
        target_user = session.get(User, req.to_user_id)
        to_email = target_user.email if target_user else ""
        offer_id = offer.id
        expires = offer.expires_at
    me = user_profile(principal.user_id) or {}
    result = send_email(
        ownership_transfer_email(
            to=to_email,
            workshop=principal.tenant_name,
            owner=str(me.get("display_name") or me.get("email") or "The owner"),
            url=_app_url("/workshop#ownership"),
        )
    )
    inc("team_ownership_offered")
    return {"id": str(offer_id), "expires_at": expires.isoformat(), "email": result.as_dict()}


@router.delete("/ownership-transfer", status_code=204)
def cancel_ownership_offer(principal: RequirePrincipal) -> None:
    require(principal, Permission.TRANSFER_OWNERSHIP)
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        offer = _expire_stale_transfer(session, principal.tenant_id, now)
        if offer is None:
            raise HTTPException(status_code=404, detail="There's no pending hand-over")
        offer.status = "CANCELLED"
        offer.resolved_at = now
        audit(session, principal, "ownership_offer_cancelled", subject_user_id=offer.to_user_id)


def _pending_for_me(session, principal: Principal, offer_id: UUID) -> OwnershipTransfer:
    offer = _expire_stale_transfer(session, principal.tenant_id, _now())
    if offer is None or offer.id != offer_id:
        raise HTTPException(
            status_code=410,
            detail="This hand-over is no longer open. Ask the owner to offer it again.",
        )
    if offer.to_user_id != principal.user_id:
        raise HTTPException(status_code=403, detail="This hand-over is for someone else")
    return offer


@router.post("/ownership-transfer/{offer_id}/accept")
def accept_ownership(offer_id: UUID, principal: RequirePrincipal) -> dict:
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        _lock_tenant(session, principal.tenant_id)
        offer = _pending_for_me(session, principal, offer_id)
        old_owner = session.get(TenantMembership, (principal.tenant_id, offer.from_user_id))
        me = session.get(TenantMembership, (principal.tenant_id, principal.user_id))
        if old_owner is None or old_owner.role != MembershipRole.OWNER or me is None:
            offer.status = "CANCELLED"
            offer.resolved_at = now
            raise HTTPException(
                status_code=409, detail="The workshop's owner has changed since this was offered"
            )
        old_owner.role = MembershipRole.LEAD_TECH
        me.role = MembershipRole.OWNER
        offer.status = "ACCEPTED"
        offer.resolved_at = now
        previous = offer.from_user_id
        audit(
            session,
            principal,
            "ownership_transferred",
            subject_user_id=previous,
            previous_owner_role="LEAD_TECH",
        )
    inc("team_ownership_transferred")
    return {"role": "OWNER", "previous_owner_id": str(previous)}


@router.post("/ownership-transfer/{offer_id}/decline")
def decline_ownership(offer_id: UUID, principal: RequirePrincipal) -> dict:
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        offer = _pending_for_me(session, principal, offer_id)
        offer.status = "DECLINED"
        offer.resolved_at = now
        audit(session, principal, "ownership_offer_declined", subject_user_id=offer.from_user_id)
    return {"status": "DECLINED"}


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
        session.add(
            TeamAuditEvent(
                tenant_id=tenant_id,
                actor_user_id=user_id,
                action="invite_accepted",
                subject_user_id=user_id,
                subject_email=email,
                detail={"role": invite.role.value},
            )
        )
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
