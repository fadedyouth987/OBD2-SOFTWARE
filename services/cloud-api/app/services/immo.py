"""Immobilizer job gates: accreditation, owner authorisation, leases, audit."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from uuid import UUID, uuid4

from sqlalchemy.exc import IntegrityError

from app.api.deps import Principal
from app.config import get_settings
from app.db.models import (
    ImmoAuditEntry,
    ImmoSession,
    OwnerAuthorisation,
    SubscriptionTier,
    TechnicianCredential,
)
from app.db.session import tenant_session
from app.db.vin import normalize_vin, resolve_secret, vin_hmac
from app.services.aasra import default_verifier
from app.services.flags import auth_allow_dev_login, immo_feature_enabled
from app.services.immo_catalog import (
    IMMO_LEASE_DEFAULT_TTL_S,
    lookup_profile,
)
from app.services.oem import OemAdapter, OemUnavailable, default_adapter
from app.services.signing import SigningKeyError, issue_immo_lease

STATUTORY_CHECK_YEARS = 2


class ImmoDenied(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _now() -> datetime:
    return datetime.now(UTC)


def _hmac(vin: str) -> str:
    key = resolve_secret(get_settings().vin_hmac_key_ref)
    return vin_hmac(vin, key)


def paperwork_current(cred: TechnicianCredential, today: date | None = None) -> bool:
    today = today or date.today()
    cutoff = date(today.year - STATUTORY_CHECK_YEARS, today.month, today.day)
    police_ok = (
        cred.national_police_check_dated is not None and cred.national_police_check_dated >= cutoff
    )
    licence_ok = (
        cred.repairer_licence_renewed_at is not None and cred.repairer_licence_renewed_at >= cutoff
    )
    return bool(cred.declaration_at) and (police_ok or licence_ok)


def is_accredited(cred: TechnicianCredential | None, now: datetime | None = None) -> bool:
    if cred is None:
        return False
    now = now or _now()
    if cred.vsp_status != "active" or cred.accredited_until is None:
        return False
    until = cred.accredited_until
    if until.tzinfo is None:
        until = until.replace(tzinfo=UTC)
    return until > now and paperwork_current(cred) and bool(cred.aasra_member_id.strip())


def record_audit(
    tenant_id: UUID,
    *,
    event: str,
    session_id: UUID | None = None,
    user_id: UUID | None = None,
    aasra_member_id: str | None = None,
    vin_hmac_value: str | None = None,
    device_id: str | None = None,
    device_tier: str | None = None,
    oem: str | None = None,
    operation: str | None = None,
    detail: str = "",
    nrc: int | None = None,
) -> None:
    # Never accept a detail that looks like a hex key or PIN.
    cleaned = (detail or "")[:500]
    if any(token in cleaned.lower() for token in ("payload_hex", "pin=", "key=")):
        cleaned = "redacted"
    now = _now()
    with tenant_session(tenant_id) as session:
        session.add(
            ImmoAuditEntry(
                tenant_id=tenant_id,
                session_id=session_id,
                at=now,
                user_id=user_id,
                aasra_member_id=aasra_member_id,
                vin_hmac=vin_hmac_value,
                device_id=device_id,
                device_tier=device_tier,
                oem=oem,
                operation=operation,
                event=event,
                nrc=nrc,
                detail=cleaned,
                retain_until=now + timedelta(days=365 * 5),
            )
        )


def require_feature() -> None:
    if not immo_feature_enabled():
        raise ImmoDenied(403, "Immobilizer support is not enabled")


def require_workshop_and_tech(principal: Principal) -> TechnicianCredential:
    require_feature()
    if principal.tier not in {SubscriptionTier.WORKSHOP, SubscriptionTier.FLEET}:
        raise ImmoDenied(403, "Immobilizer tools require a Workshop or Fleet plan")
    if not principal.immo_entitled:
        raise ImmoDenied(403, "Immobilizer add-on is not active on this workspace")
    verified = default_verifier().is_verified(
        principal.tenant_id, tenant_flag=principal.aasra_verified
    )
    if not verified:
        raise ImmoDenied(403, "Workshop is not AASRA-verified")
    with tenant_session(principal.tenant_id) as session:
        cred = session.get(TechnicianCredential, (principal.tenant_id, principal.user_id))
        # Detach before the session closes.
        if cred is not None:
            session.expunge(cred)
    if not is_accredited(cred):
        raise ImmoDenied(403, "Technician is not accredited for security information")
    assert cred is not None
    return cred


def enrol_technician(
    principal: Principal,
    *,
    aasra_member_id: str,
    national_police_check_dated: date | None,
    repairer_licence_renewed_at: date | None,
    declared: bool,
) -> TechnicianCredential:
    require_feature()
    member = aasra_member_id.strip()
    if not member:
        raise ImmoDenied(400, "aasra_member_id is required")
    if national_police_check_dated is None and repairer_licence_renewed_at is None:
        raise ImmoDenied(
            400, "A national police check date or repairer licence renewal date is required"
        )
    if not declared:
        raise ImmoDenied(400, "A written declaration is required")
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        cred = session.get(TechnicianCredential, (principal.tenant_id, principal.user_id))
        if cred is None:
            cred = TechnicianCredential(
                tenant_id=principal.tenant_id,
                user_id=principal.user_id,
                aasra_member_id=member,
            )
            session.add(cred)
        cred.aasra_member_id = member
        cred.national_police_check_dated = national_police_check_dated
        cred.repairer_licence_renewed_at = repairer_licence_renewed_at
        cred.declaration_at = now
        cred.updated_at = now
        if auth_allow_dev_login() and paperwork_current(cred):
            cred.vsp_status = "active"
            cred.accredited_until = now + timedelta(days=365)
        else:
            # Production: record paperwork only. Real AASRA verification is not built yet.
            cred.vsp_status = "pending"
            cred.accredited_until = None
        session.flush()
        session.expunge(cred)
    return cred


def create_authorisation(principal: Principal, vin: str) -> OwnerAuthorisation:
    cred = require_workshop_and_tech(principal)
    try:
        normalized = normalize_vin(vin)
    except ValueError as exc:
        raise ImmoDenied(400, str(exc)) from exc
    digest = _hmac(normalized)
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        row = OwnerAuthorisation(
            id=uuid4(),
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            vin_hmac=digest,
            declared_at=now,
            expires_at=now + timedelta(hours=24),
        )
        session.add(row)
        session.flush()
        session.expunge(row)
    record_audit(
        principal.tenant_id,
        event="issued",
        user_id=principal.user_id,
        aasra_member_id=cred.aasra_member_id,
        vin_hmac_value=digest,
        detail="owner authorisation recorded",
    )
    return row


def start_session(
    principal: Principal,
    *,
    vin: str,
    authorisation_id: UUID,
    oem: str,
    operation: str,
    device_id: str,
    device_tier: str,
    ttl_s: int = IMMO_LEASE_DEFAULT_TTL_S,
) -> dict:
    cred = require_workshop_and_tech(principal)
    profile = lookup_profile(oem, operation, device_tier)
    if profile is None:
        raise ImmoDenied(403, "Operation is not on the immobilizer allow-list")
    try:
        normalized = normalize_vin(vin)
    except ValueError as exc:
        raise ImmoDenied(400, str(exc)) from exc
    digest = _hmac(normalized)
    device = (device_id or "").strip()
    if not device:
        raise ImmoDenied(400, "device_id is required")
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        auth = session.get(OwnerAuthorisation, authorisation_id)
        if auth is None or auth.tenant_id != principal.tenant_id:
            raise ImmoDenied(403, "Owner authorisation not found")
        if auth.vin_hmac != digest:
            raise ImmoDenied(403, "Owner authorisation does not match this VIN")
        if auth.expires_at is not None:
            exp = auth.expires_at if auth.expires_at.tzinfo else auth.expires_at.replace(tzinfo=UTC)
            if exp <= now:
                raise ImmoDenied(403, "Owner authorisation has expired")
        job_id = uuid4()
        jti = str(uuid4())
        try:
            lease = issue_immo_lease(
                str(principal.tenant_id),
                str(principal.user_id),
                session_id=str(job_id),
                jti=jti,
                vin=normalized,
                device_id=device,
                device_tier=profile.device_tier,
                oem=profile.oem,
                operation=profile.operation,
                ttl_s=ttl_s,
            )
        except SigningKeyError as exc:
            raise ImmoDenied(503, str(exc)) from exc
        expires = datetime.fromtimestamp(lease["expires_at"], tz=UTC)
        row = ImmoSession(
            id=job_id,
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            authorisation_id=auth.id,
            vin_hmac=digest,
            oem=profile.oem,
            operation=profile.operation,
            device_id=device,
            device_tier=profile.device_tier,
            lease_jti=jti,
            expires_at=expires,
            status="active",
        )
        session.add(row)
        try:
            session.flush()
        except IntegrityError as exc:
            raise ImmoDenied(
                409, "An immobilizer session is already active for this VIN or device"
            ) from exc
    record_audit(
        principal.tenant_id,
        event="issued",
        session_id=job_id,
        user_id=principal.user_id,
        aasra_member_id=cred.aasra_member_id,
        vin_hmac_value=digest,
        device_id=device,
        device_tier=profile.device_tier,
        oem=profile.oem,
        operation=profile.operation,
        detail="immo_lease issued",
    )
    return {
        "session_id": str(job_id),
        "status": "active",
        "lease": lease,
        "ecu_tx": profile.ecu_tx,
        "ecu_rx": profile.ecu_rx,
        "profile_id": profile.profile_id,
    }


def _load_active(
    principal: Principal, session_id: UUID
) -> tuple[ImmoSession, TechnicianCredential]:
    cred = require_workshop_and_tech(principal)
    with tenant_session(principal.tenant_id) as session:
        row = session.get(ImmoSession, session_id)
        if row is None or row.tenant_id != principal.tenant_id or row.user_id != principal.user_id:
            raise ImmoDenied(404, "Immobilizer session not found")
        session.expunge(row)
    return row, cred


def fetch_token(principal: Principal, session_id: UUID, adapter: OemAdapter | None = None) -> dict:
    row, cred = _load_active(principal, session_id)
    if row.status not in {"pending", "active"}:
        raise ImmoDenied(409, f"Session is {row.status}")
    if row.expires_at.tzinfo is None:
        exp = row.expires_at.replace(tzinfo=UTC)
    else:
        exp = row.expires_at
    if exp <= _now():
        raise ImmoDenied(409, "Session lease has expired")
    adapter = adapter or default_adapter()
    try:
        token = adapter.issue_token(oem=row.oem, operation=row.operation)
    except OemUnavailable as exc:
        record_audit(
            principal.tenant_id,
            event="refused",
            session_id=session_id,
            user_id=principal.user_id,
            aasra_member_id=cred.aasra_member_id,
            vin_hmac_value=row.vin_hmac,
            device_id=row.device_id,
            device_tier=row.device_tier,
            oem=row.oem,
            operation=row.operation,
            detail="oem token unavailable",
        )
        raise ImmoDenied(503, str(exc)) from exc
    with tenant_session(principal.tenant_id) as session:
        live = session.get(ImmoSession, session_id)
        if live is not None:
            live.token_fetched_at = _now()
            live.status = "active"
    record_audit(
        principal.tenant_id,
        event="token_fetched",
        session_id=session_id,
        user_id=principal.user_id,
        aasra_member_id=cred.aasra_member_id,
        vin_hmac_value=row.vin_hmac,
        device_id=row.device_id,
        device_tier=row.device_tier,
        oem=row.oem,
        operation=row.operation,
        detail="oem token issued (secret not stored)",
    )
    return {
        "session_id": str(session_id),
        "oem": token.oem,
        "operation": token.operation,
        "payload_hex": token.payload_hex,
        "description": token.description,
    }


def complete_or_abort(principal: Principal, session_id: UUID, *, abort: bool) -> dict:
    row, cred = _load_active(principal, session_id)
    if row.status in {"completed", "aborted"}:
        raise ImmoDenied(409, f"Session is already {row.status}")
    status = "aborted" if abort else "completed"
    event = "aborted" if abort else "completed"
    now = _now()
    with tenant_session(principal.tenant_id) as session:
        live = session.get(ImmoSession, session_id)
        if live is None:
            raise ImmoDenied(404, "Immobilizer session not found")
        if live.status in {"completed", "aborted"}:
            raise ImmoDenied(409, f"Session is already {live.status}")
        live.status = status
        live.completed_at = now
        live.updated_at = now
    record_audit(
        principal.tenant_id,
        event=event,
        session_id=session_id,
        user_id=principal.user_id,
        aasra_member_id=cred.aasra_member_id,
        vin_hmac_value=row.vin_hmac,
        device_id=row.device_id,
        device_tier=row.device_tier,
        oem=row.oem,
        operation=row.operation,
        detail=status,
    )
    return {"session_id": str(session_id), "status": status}


def get_session(principal: Principal, session_id: UUID) -> dict:
    row, _cred = _load_active(principal, session_id)
    return {
        "session_id": str(row.id),
        "status": row.status,
        "oem": row.oem,
        "operation": row.operation,
        "device_id": row.device_id,
        "device_tier": row.device_tier,
        "expires_at": int(row.expires_at.timestamp()),
        "token_fetched": row.token_fetched_at is not None,
    }
