"""AASRA / MVIS accreditation, reviewed by a platform admin.

A technician (or a workshop Owner, for the workshop itself) submits their AASRA
member details, statutory paperwork dates and evidence files. A platform admin
looks at the evidence and approves with an expiry date, or rejects with a
reason. Approval is what makes a technician "accredited" for key programming
(``TechnicianCredential``) or a workshop "AASRA-verified" (``tenants``).

Expiry is enforced at the point of use (``is_accredited`` and the principal's
``aasra_verified`` both check the date). ``run_reminders`` emails the subject
before it lapses (``ACCREDITATION_REMINDER_DAYS``, default 30 and 7 days) and
marks lapsed approvals EXPIRED; run it daily (``python -m app.cli
accreditation-reminders``) or from the admin screen.

Every step is written to accreditation_events. There is no automatic approval
in production: ``AASRA_DEV_AUTO_APPROVE=true`` approves on submit, and only works
together with ``AUTH_ALLOW_DEV_LOGIN=true`` on a local install.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.api.deps import Principal
from app.config import get_settings
from app.db.models import (
    AccreditationEvent,
    AccreditationEvidence,
    AccreditationRequest,
    MembershipRole,
    TechnicianCredential,
    Tenant,
    TenantMembership,
    User,
)
from app.db.session import owner_engine, tenant_session
from app.observability.metrics import inc
from app.services import object_store
from app.services.email import (
    accreditation_decision_email,
    accreditation_lapsed_email,
    accreditation_reminder_email,
    send_email,
)
from app.services.flags import auth_allow_dev_login, env_flag

log = logging.getLogger(__name__)

ADELAIDE = ZoneInfo("Australia/Adelaide")
WORKSHOP = "WORKSHOP"
TECHNICIAN = "TECHNICIAN"
KIND_LABEL = {WORKSHOP: "Workshop AASRA accreditation", TECHNICIAN: "Technician accreditation"}
EVIDENCE_MAX_BYTES = 10 * 1024 * 1024
EVIDENCE_MAX_FILES = 5
DEFAULT_TERM_DAYS = 365
MAX_TERM_DAYS = 730
STATUTORY_YEARS = 2
MIN_REASON = 10
_TYPES = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg"}


def _now() -> datetime:
    return datetime.now(UTC)


def dev_auto_approve() -> bool:
    """Explicit local-only shortcut; needs both flags so it can't leak into production."""
    return env_flag("AASRA_DEV_AUTO_APPROVE") and auth_allow_dev_login()


def reminder_days() -> list[int]:
    raw = get_settings().accreditation_reminder_days or ""
    days = sorted({int(x) for x in raw.replace(" ", "").split(",") if x.isdigit()}, reverse=True)
    return [d for d in days if 0 < d <= 365] or [30, 7]


def sniff(data: bytes) -> str | None:
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return None


def normalize_abn(raw: str) -> str:
    """An 11-digit Australian Business Number with a valid check sum (ATO algorithm)."""
    digits = "".join(c for c in raw if c.isdigit())
    if len(digits) != 11:
        raise HTTPException(status_code=422, detail="An ABN has 11 digits")
    weights = (10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19)
    nums = [int(c) for c in digits]
    nums[0] -= 1
    if sum(w * n for w, n in zip(weights, nums, strict=True)) % 89 != 0:
        raise HTTPException(status_code=422, detail="That ABN isn't valid. Check the digits.")
    return digits


def _years_before(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year - years)
    except ValueError:  # 29 Feb
        return day.replace(year=day.year - years, day=28)


def _years_after(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:
        return day.replace(year=day.year + years, day=28)


def _end_of_day(day: date) -> datetime:
    return datetime.combine(day, time(23, 59, 59), tzinfo=ADELAIDE).astimezone(UTC)


def _local_date(value: datetime) -> str:
    return value.astimezone(ADELAIDE).strftime("%-d %b %Y")


def _app_url(path: str) -> str:
    return f"{get_settings().public_app_url.rstrip('/')}{path}"


@dataclass(frozen=True)
class EvidenceFile:
    filename: str
    data: bytes


def _paperwork_limit(req: AccreditationRequest) -> date | None:
    """A technician's approval can't outlast their police check or licence (2 years)."""
    dates = [d for d in (req.national_police_check_dated, req.repairer_licence_renewed_at) if d]
    if not dates:
        return None
    return _years_after(max(dates), STATUTORY_YEARS)


def _event(session: Session, req: AccreditationRequest, event: str, actor: UUID | None, **detail):
    session.add(
        AccreditationEvent(
            request_id=req.id,
            tenant_id=req.tenant_id,
            actor_user_id=actor,
            event=event,
            detail={k: v for k, v in detail.items() if v is not None},
        )
    )


# --- submitting -------------------------------------------------------------------


def _check_files(files: list[EvidenceFile]) -> list[tuple[EvidenceFile, str]]:
    if len(files) > EVIDENCE_MAX_FILES:
        raise HTTPException(
            status_code=422, detail=f"Attach up to {EVIDENCE_MAX_FILES} evidence files"
        )
    checked = []
    for f in files:
        if not f.data:
            raise HTTPException(status_code=422, detail=f"{f.filename} is empty")
        if len(f.data) > EVIDENCE_MAX_BYTES:
            raise HTTPException(status_code=413, detail=f"{f.filename} is over 10 MB")
        ctype = sniff(f.data)
        if ctype is None:
            raise HTTPException(
                status_code=415, detail=f"{f.filename}: upload evidence as PDF, PNG or JPEG"
            )
        checked.append((f, ctype))
    return checked


def submit(
    principal: Principal,
    kind: str,
    *,
    aasra_member_id: str,
    declared: bool,
    files: list[EvidenceFile],
    business_abn: str | None = None,
    national_police_check_dated: date | None = None,
    repairer_licence_renewed_at: date | None = None,
) -> dict:
    member = " ".join(aasra_member_id.split())
    if not member or len(member) > 64:
        raise HTTPException(status_code=422, detail="Enter the AASRA member ID")
    if not declared:
        raise HTTPException(status_code=422, detail="Tick the declaration to submit")
    abn = None
    if kind == WORKSHOP:
        abn = normalize_abn(business_abn or "")
    else:
        if national_police_check_dated is None and repairer_licence_renewed_at is None:
            raise HTTPException(
                status_code=422,
                detail="Enter a national police check date or a repairer licence renewal date",
            )
        today = datetime.now(ADELAIDE).date()
        cutoff = _years_before(today, STATUTORY_YEARS)
        for label, value in (
            ("police check", national_police_check_dated),
            ("licence renewal", repairer_licence_renewed_at),
        ):
            if value and value > today:
                raise HTTPException(status_code=422, detail=f"The {label} date is in the future")
        if not any(
            d and d >= cutoff for d in (national_police_check_dated, repairer_licence_renewed_at)
        ):
            raise HTTPException(
                status_code=422,
                detail="Your police check or licence renewal must be from the last 2 years",
            )
    auto = dev_auto_approve()
    checked = _check_files(files)
    if not checked and not auto:
        raise HTTPException(
            status_code=422,
            detail=(
                "Attach evidence: your AASRA membership confirmation and police check or licence"
            ),
        )

    request_id = uuid4()
    stored: list[tuple[str, EvidenceFile, str]] = []
    try:
        for f, ctype in checked:
            key = object_store.object_key(
                "accreditation", principal.tenant_id, uuid4(), _TYPES[ctype]
            )
            object_store.put(key, f.data, ctype)
            stored.append((key, f, ctype))
    except object_store.StorageError as exc:
        _forget(stored)
        raise HTTPException(
            status_code=503, detail="File storage is unavailable. Try again shortly."
        ) from exc

    now = _now()
    try:
        with tenant_session(principal.tenant_id) as session:
            pending = session.scalars(
                select(AccreditationRequest).where(
                    AccreditationRequest.tenant_id == principal.tenant_id,
                    AccreditationRequest.kind == kind,
                    AccreditationRequest.status == "PENDING",
                    *(
                        [AccreditationRequest.user_id == principal.user_id]
                        if kind == TECHNICIAN
                        else []
                    ),
                )
            ).all()
            for old in pending:
                old.status = "SUPERSEDED"
                old.reviewed_at = now
                _event(session, old, "superseded", principal.user_id, by=str(request_id))
            session.flush()
            req = AccreditationRequest(
                id=request_id,
                tenant_id=principal.tenant_id,
                kind=kind,
                user_id=principal.user_id,
                aasra_member_id=member,
                business_abn=abn,
                national_police_check_dated=national_police_check_dated,
                repairer_licence_renewed_at=repairer_licence_renewed_at,
                declaration_at=now,
                status="PENDING",
                submitted_at=now,
                reminders_sent=[],
            )
            session.add(req)
            session.flush()
            for key, f, ctype in stored:
                session.add(
                    AccreditationEvidence(
                        request_id=request_id,
                        tenant_id=principal.tenant_id,
                        s3_key=key,
                        filename=_safe_name(f.filename),
                        content_type=ctype,
                        size_bytes=len(f.data),
                        sha256=hashlib.sha256(f.data).hexdigest(),
                    )
                )
            _event(session, req, "submitted", principal.user_id, evidence_files=len(stored))
            if kind == TECHNICIAN:
                _record_paperwork(session, req, now)
            if auto:
                term = _default_expiry(req)
                _apply_approval(session, req, term, actor=None, now=now)
                _event(
                    session,
                    req,
                    "approved",
                    None,
                    dev_auto_approve=True,
                    expires_at=term.isoformat(),
                )
    except Exception:
        _forget(stored)
        raise
    inc("accreditation_submitted")
    return subject_status(principal)


def _forget(stored) -> None:
    for key, *_ in stored:
        try:
            object_store.delete(key)
        except object_store.StorageError:
            pass


def _safe_name(name: str) -> str:
    cleaned = "".join(c if c.isalnum() or c in " ._-()" else "_" for c in (name or "evidence"))
    return cleaned.strip()[:120] or "evidence"


def _record_paperwork(session: Session, req: AccreditationRequest, now: datetime) -> None:
    """Keep the credential's paperwork current; a renewal doesn't pause an active approval."""
    cred = session.get(TechnicianCredential, (req.tenant_id, req.user_id))
    if cred is None:
        cred = TechnicianCredential(
            tenant_id=req.tenant_id,
            user_id=req.user_id,
            aasra_member_id=req.aasra_member_id,
            vsp_status="pending",
        )
        session.add(cred)
    active = (
        cred.vsp_status == "active"
        and cred.accredited_until is not None
        and cred.accredited_until > now
    )
    if not active:
        cred.vsp_status = "pending"
        cred.accredited_until = None
        cred.aasra_member_id = req.aasra_member_id
        cred.national_police_check_dated = req.national_police_check_dated
        cred.repairer_licence_renewed_at = req.repairer_licence_renewed_at
        cred.declaration_at = now
    cred.updated_at = now


def _default_expiry(req: AccreditationRequest) -> datetime:
    today = datetime.now(ADELAIDE).date()
    day = today + timedelta(days=DEFAULT_TERM_DAYS)
    limit = _paperwork_limit(req) if req.kind == TECHNICIAN else None
    if limit is not None:
        day = min(day, limit)
    return _end_of_day(day)


def _apply_approval(
    session: Session, req: AccreditationRequest, expires_at: datetime, *, actor, now
) -> None:
    for old in session.scalars(
        select(AccreditationRequest).where(
            AccreditationRequest.tenant_id == req.tenant_id,
            AccreditationRequest.kind == req.kind,
            AccreditationRequest.status == "APPROVED",
            AccreditationRequest.id != req.id,
            *([AccreditationRequest.user_id == req.user_id] if req.kind == TECHNICIAN else []),
        )
    ).all():
        old.status = "SUPERSEDED"
        _event(session, old, "superseded", actor, by=str(req.id))
    req.status = "APPROVED"
    req.reviewed_at = now
    req.reviewed_by = actor
    req.expires_at = expires_at
    req.decision_reason = None
    req.reminders_sent = []
    if req.kind == TECHNICIAN:
        cred = session.get(TechnicianCredential, (req.tenant_id, req.user_id))
        if cred is None:
            cred = TechnicianCredential(tenant_id=req.tenant_id, user_id=req.user_id)
            session.add(cred)
        cred.aasra_member_id = req.aasra_member_id
        cred.national_police_check_dated = req.national_police_check_dated
        cred.repairer_licence_renewed_at = req.repairer_licence_renewed_at
        cred.declaration_at = req.declaration_at
        cred.vsp_status = "active"
        cred.accredited_until = expires_at
        cred.updated_at = now
    else:
        tenant = session.get(Tenant, req.tenant_id)
        if tenant is not None:
            tenant.aasra_verified = True
            tenant.aasra_verified_until = expires_at
            # Leases carry aasra_verified: make the daemon pick up the change.
            tenant.lease_version = int(tenant.lease_version or 0) + 1


def _clear_approval(session: Session, req: AccreditationRequest, status: str, now) -> None:
    if req.kind == TECHNICIAN:
        cred = session.get(TechnicianCredential, (req.tenant_id, req.user_id))
        if cred is not None:
            cred.vsp_status = status.lower()
            cred.accredited_until = None
            cred.updated_at = now
    else:
        tenant = session.get(Tenant, req.tenant_id)
        if tenant is not None:
            tenant.aasra_verified = False
            tenant.aasra_verified_until = None
            tenant.lease_version = int(tenant.lease_version or 0) + 1


# --- what the subject sees -------------------------------------------------------


def _request_json(req: AccreditationRequest, evidence: list[AccreditationEvidence]) -> dict:
    return {
        "id": str(req.id),
        "kind": req.kind,
        "status": req.status,
        "aasra_member_id": req.aasra_member_id,
        "business_abn": req.business_abn,
        "national_police_check_dated": (
            req.national_police_check_dated.isoformat() if req.national_police_check_dated else None
        ),
        "repairer_licence_renewed_at": (
            req.repairer_licence_renewed_at.isoformat() if req.repairer_licence_renewed_at else None
        ),
        "submitted_at": req.submitted_at.isoformat() if req.submitted_at else None,
        "reviewed_at": req.reviewed_at.isoformat() if req.reviewed_at else None,
        "decision_reason": req.decision_reason,
        "expires_at": req.expires_at.isoformat() if req.expires_at else None,
        "evidence": [
            {
                "id": str(e.id),
                "filename": e.filename,
                "content_type": e.content_type,
                "size_bytes": e.size_bytes,
            }
            for e in evidence
        ],
    }


def _latest(session: Session, tenant_id: UUID, kind: str, user_id: UUID | None):
    query = select(AccreditationRequest).where(
        AccreditationRequest.tenant_id == tenant_id,
        AccreditationRequest.kind == kind,
        AccreditationRequest.status != "SUPERSEDED",
    )
    if user_id is not None:
        query = query.where(AccreditationRequest.user_id == user_id)
    reqs = session.scalars(query.order_by(AccreditationRequest.submitted_at.desc()).limit(5)).all()
    current = next((r for r in reqs if r.status == "APPROVED"), None)
    pending = next((r for r in reqs if r.status == "PENDING"), None)
    latest = reqs[0] if reqs else None

    def pack(r):
        if r is None:
            return None
        ev = session.scalars(
            select(AccreditationEvidence).where(AccreditationEvidence.request_id == r.id)
        ).all()
        return _request_json(r, list(ev))

    return {"current": pack(current), "pending": pack(pending), "latest": pack(latest)}


def _state(block: dict, now: datetime) -> str:
    cur = block["current"]
    if cur and cur["expires_at"] and datetime.fromisoformat(cur["expires_at"]) > now:
        return "renewal_pending" if block["pending"] else "approved"
    if block["pending"]:
        return "pending"
    latest = block["latest"]
    if latest is None:
        return "not_submitted"
    return {"REJECTED": "rejected", "EXPIRED": "expired", "REVOKED": "revoked"}.get(
        latest["status"], "not_submitted"
    )


def subject_status(principal: Principal) -> dict:
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        tech = _latest(session, principal.tenant_id, TECHNICIAN, principal.user_id)
        shop = _latest(session, principal.tenant_id, WORKSHOP, None)
    days = reminder_days()
    return {
        "technician": {**tech, "state": _state(tech, now)},
        "workshop": {**shop, "state": _state(shop, now)},
        "evidence_rules": {
            "max_files": EVIDENCE_MAX_FILES,
            "max_bytes": EVIDENCE_MAX_BYTES,
            "types": list(_TYPES),
        },
        "reminder_days": days,
        "dev_auto_approve": dev_auto_approve(),
    }


def member_evidence(principal: Principal, evidence_id: UUID) -> tuple[str, str, str]:
    """A technician's own evidence, or the workshop's evidence for its Owner."""
    with tenant_session(principal.tenant_id) as session:
        ev = session.get(AccreditationEvidence, evidence_id)
        req = session.get(AccreditationRequest, ev.request_id) if ev else None
        if ev is None or req is None:
            raise HTTPException(status_code=404, detail="No evidence with that id")
        mine = req.kind == TECHNICIAN and req.user_id == principal.user_id
        owner = req.kind == WORKSHOP and principal.role == MembershipRole.OWNER
        if not (mine or owner):
            raise HTTPException(status_code=404, detail="No evidence with that id")
        return ev.s3_key, ev.content_type, ev.filename


# --- platform admin ---------------------------------------------------------------


def is_platform_admin(user_id: UUID) -> bool:
    with owner_engine().connect() as conn:
        return bool(
            conn.execute(
                text("SELECT platform_admin FROM users WHERE id = :id"), {"id": user_id}
            ).scalar()
        )


def set_platform_admin(email: str, value: bool) -> bool:
    with owner_engine().begin() as conn:
        res = conn.execute(
            text("UPDATE users SET platform_admin = :v WHERE email = :e"),
            {"v": value, "e": email.strip().lower()},
        )
        return res.rowcount == 1


def admin_queue(status: str, limit: int = 100) -> list[dict]:
    with Session(owner_engine()) as session:
        query = select(AccreditationRequest).order_by(AccreditationRequest.submitted_at.asc())
        if status != "ALL":
            query = query.where(AccreditationRequest.status == status)
        reqs = session.scalars(query.limit(limit)).all()
        out = []
        for r in reqs:
            tenant = session.get(Tenant, r.tenant_id)
            user = session.get(User, r.user_id)
            evidence = session.scalars(
                select(AccreditationEvidence).where(AccreditationEvidence.request_id == r.id)
            ).all()
            events = session.scalars(
                select(AccreditationEvent)
                .where(AccreditationEvent.request_id == r.id)
                .order_by(AccreditationEvent.at)
            ).all()
            item = _request_json(r, list(evidence))
            item.update(
                {
                    "workshop": tenant.name if tenant else None,
                    "tenant_id": str(r.tenant_id),
                    "subject_name": (user.display_name or user.email) if user else None,
                    "subject_email": user.email if user else None,
                    "paperwork_limit": (
                        _paperwork_limit(r).isoformat()
                        if r.kind == TECHNICIAN and _paperwork_limit(r)
                        else None
                    ),
                    "events": [
                        {
                            "at": e.at.isoformat() if e.at else None,
                            "event": e.event,
                            "detail": e.detail or {},
                        }
                        for e in events
                    ],
                }
            )
            out.append(item)
        return out


def admin_evidence(request_id: UUID, evidence_id: UUID) -> tuple[str, str, str]:
    with Session(owner_engine()) as session:
        ev = session.get(AccreditationEvidence, evidence_id)
        if ev is None or ev.request_id != request_id:
            raise HTTPException(status_code=404, detail="No evidence with that id")
        return ev.s3_key, ev.content_type, ev.filename


def _recipients(session: Session, req: AccreditationRequest) -> list[str]:
    emails: list[str] = []
    user = session.get(User, req.user_id)
    if user is not None:
        emails.append(user.email)
    if req.kind == WORKSHOP:
        owners = session.execute(
            select(User.email)
            .join(TenantMembership, TenantMembership.user_id == User.id)
            .where(
                TenantMembership.tenant_id == req.tenant_id,
                TenantMembership.role == MembershipRole.OWNER,
            )
        ).scalars()
        emails.extend(owners)
    return sorted(set(emails))


def _load_for_review(session: Session, request_id: UUID, status: str) -> AccreditationRequest:
    req = session.scalars(
        select(AccreditationRequest).where(AccreditationRequest.id == request_id).with_for_update()
    ).one_or_none()
    if req is None:
        raise HTTPException(status_code=404, detail="No accreditation request with that id")
    if req.status != status:
        raise HTTPException(
            status_code=409, detail=f"This request is {req.status.lower()}, not {status.lower()}"
        )
    return req


def approve(admin_id: UUID, request_id: UUID, expires_on: date | None) -> dict:
    now = _now()
    today = datetime.now(ADELAIDE).date()
    with Session(owner_engine()) as session, session.begin():
        req = _load_for_review(session, request_id, "PENDING")
        if req.user_id == admin_id:
            raise HTTPException(status_code=403, detail="You can't review your own accreditation")
        limit = _paperwork_limit(req) if req.kind == TECHNICIAN else None
        day = expires_on or (_default_expiry(req).astimezone(ADELAIDE).date())
        if day <= today:
            raise HTTPException(status_code=422, detail="Pick an expiry date after today")
        if day > today + timedelta(days=MAX_TERM_DAYS):
            raise HTTPException(status_code=422, detail="Approvals last at most 2 years")
        if limit is not None and day > limit:
            raise HTTPException(
                status_code=422,
                detail=(
                    "The police check or licence runs out on "
                    f"{limit.strftime('%-d %b %Y')}; pick that date or earlier"
                ),
            )
        expires_at = _end_of_day(day)
        _apply_approval(session, req, expires_at, actor=admin_id, now=now)
        _event(session, req, "approved", admin_id, expires_at=expires_at.isoformat())
        to = _recipients(session, req)
        kind = req.kind
    for addr in to:
        send_email(
            accreditation_decision_email(
                to=addr,
                subject_label=KIND_LABEL[kind],
                approved=True,
                reason="",
                until=_local_date(expires_at),
                url=_app_url("/key-programming"),
            )
        )
    inc("accreditation_approved")
    return {"id": str(request_id), "status": "APPROVED", "expires_at": expires_at.isoformat()}


def _reason(reason: str) -> str:
    cleaned = " ".join((reason or "").split())
    if len(cleaned) < MIN_REASON:
        raise HTTPException(
            status_code=422, detail="Give a reason the applicant can act on (10+ characters)"
        )
    return cleaned[:1000]


def reject(admin_id: UUID, request_id: UUID, reason: str) -> dict:
    why = _reason(reason)
    now = _now()
    with Session(owner_engine()) as session, session.begin():
        req = _load_for_review(session, request_id, "PENDING")
        if req.user_id == admin_id:
            raise HTTPException(status_code=403, detail="You can't review your own accreditation")
        req.status = "REJECTED"
        req.reviewed_at = now
        req.reviewed_by = admin_id
        req.decision_reason = why
        if req.kind == TECHNICIAN:
            cred = session.get(TechnicianCredential, (req.tenant_id, req.user_id))
            still_active = (
                cred is not None
                and cred.vsp_status == "active"
                and cred.accredited_until is not None
                and cred.accredited_until > now
            )
            if cred is not None and not still_active:
                cred.vsp_status = "rejected"
                cred.updated_at = now
        _event(session, req, "rejected", admin_id, reason=why)
        to = _recipients(session, req)
        kind = req.kind
    for addr in to:
        send_email(
            accreditation_decision_email(
                to=addr,
                subject_label=KIND_LABEL[kind],
                approved=False,
                reason=why,
                until=None,
                url=_app_url("/key-programming"),
            )
        )
    inc("accreditation_rejected")
    return {"id": str(request_id), "status": "REJECTED", "reason": why}


def revoke(admin_id: UUID, request_id: UUID, reason: str) -> dict:
    why = _reason(reason)
    now = _now()
    with Session(owner_engine()) as session, session.begin():
        req = _load_for_review(session, request_id, "APPROVED")
        req.status = "REVOKED"
        req.reviewed_at = now
        req.reviewed_by = admin_id
        req.decision_reason = why
        _clear_approval(session, req, "revoked", now)
        _event(session, req, "revoked", admin_id, reason=why)
        to = _recipients(session, req)
        kind = req.kind
    for addr in to:
        send_email(
            accreditation_decision_email(
                to=addr,
                subject_label=KIND_LABEL[kind],
                approved=False,
                reason=f"Revoked: {why}",
                until=None,
                url=_app_url("/key-programming"),
            )
        )
    inc("accreditation_revoked")
    return {"id": str(request_id), "status": "REVOKED", "reason": why}


def run_reminders(now: datetime | None = None) -> dict:
    """Email reminders before approvals lapse, and lapse the ones past their date."""
    now = now or _now()
    days = reminder_days()
    horizon = now + timedelta(days=max(days) + 1)
    reminded = expired = 0
    outgoing: list = []
    with Session(owner_engine()) as session, session.begin():
        due = session.scalars(
            select(AccreditationRequest)
            .where(
                AccreditationRequest.status == "APPROVED",
                AccreditationRequest.expires_at <= horizon,
            )
            .with_for_update(skip_locked=True)
        ).all()
        for req in due:
            assert req.expires_at is not None
            to = _recipients(session, req)
            label = KIND_LABEL[req.kind]
            if req.expires_at <= now:
                req.status = "EXPIRED"
                _clear_approval(session, req, "expired", now)
                _event(session, req, "expired", None)
                outgoing += [
                    accreditation_lapsed_email(
                        to=a, subject_label=label, url=_app_url("/key-programming")
                    )
                    for a in to
                ]
                expired += 1
                continue
            left = (req.expires_at - now).days
            sent = set(req.reminders_sent or [])
            stage = min((d for d in days if left <= d and d not in sent), default=None)
            if stage is None:
                continue
            # Record every threshold already passed, so a late run sends one email, not three.
            req.reminders_sent = sorted(sent | {d for d in days if left <= d}, reverse=True)
            _event(session, req, "reminder_sent", None, days_left=left, stage=stage)
            outgoing += [
                accreditation_reminder_email(
                    to=a,
                    subject_label=label,
                    until=_local_date(req.expires_at),
                    days_left=left,
                    url=_app_url("/key-programming"),
                )
                for a in to
            ]
            reminded += 1
    delivered = sum(1 for msg in outgoing if send_email(msg).sent)
    inc("accreditation_reminders", reminded)
    return {"reminded": reminded, "expired": expired, "emails_sent": delivered}
