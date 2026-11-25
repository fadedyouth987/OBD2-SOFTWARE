"""Immobilizer job API: enrol, authorise, start, fetch token, complete, abort."""

from __future__ import annotations

from datetime import date
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.deps import RequirePrincipal
from app.observability.metrics import inc
from app.services.immo import (
    ImmoDenied,
    complete_or_abort,
    create_authorisation,
    enrol_technician,
    fetch_token,
    get_session,
    is_accredited,
    require_feature,
    require_workshop_and_tech,
    start_session,
)
from app.services.immo_catalog import IMMO_LEASE_DEFAULT_TTL_S, IMMO_LEASE_MAX_TTL_S

router = APIRouter(prefix="/api/v1/immo", tags=["immo"])


def _raise(exc: ImmoDenied) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


class EnrolRequest(BaseModel):
    aasra_member_id: str = Field(min_length=1, max_length=64)
    national_police_check_dated: date | None = None
    repairer_licence_renewed_at: date | None = None
    declared: bool = False
    # Ignored identity fields: accepted so old clients do not 422, never trusted.
    tenant_id: str | None = None
    user_id: str | None = None
    aasra_verified: bool | None = None


class AuthorisationRequest(BaseModel):
    vin: str
    tenant_id: str | None = None


class StartJobRequest(BaseModel):
    vin: str
    authorisation_id: UUID
    oem: str
    operation: str
    device_id: str
    device_tier: str = "dongle"
    ttl_s: int = Field(default=IMMO_LEASE_DEFAULT_TTL_S, ge=1, le=IMMO_LEASE_MAX_TTL_S)
    # Ignored: never trusted from the client.
    aasra_verified: bool | None = None
    tenant_id: str | None = None
    user_id: str | None = None


@router.post("/technicians/enrol")
def enrol(req: EnrolRequest, principal: RequirePrincipal) -> dict:
    try:
        cred = enrol_technician(
            principal,
            aasra_member_id=req.aasra_member_id,
            national_police_check_dated=req.national_police_check_dated,
            repairer_licence_renewed_at=req.repairer_licence_renewed_at,
            declared=req.declared,
        )
    except ImmoDenied as exc:
        _raise(exc)
        raise
    inc("immo_technician_enrolled")
    return {
        "user_id": str(principal.user_id),
        "aasra_member_id": cred.aasra_member_id,
        "vsp_status": cred.vsp_status,
        "accredited": is_accredited(cred),
    }


@router.get("/technicians/me")
def me(principal: RequirePrincipal) -> dict:
    try:
        require_feature()
        cred = require_workshop_and_tech(principal)
    except ImmoDenied as exc:
        _raise(exc)
        raise
    return {
        "user_id": str(principal.user_id),
        "aasra_member_id": cred.aasra_member_id,
        "vsp_status": cred.vsp_status,
        "accredited": True,
    }


@router.post("/owner-authorisations")
def owner_authorise(req: AuthorisationRequest, principal: RequirePrincipal) -> dict:
    try:
        row = create_authorisation(principal, req.vin)
    except ImmoDenied as exc:
        _raise(exc)
        raise
    inc("immo_owner_authorisation_recorded")
    return {
        "id": str(row.id),
        "expires_at": int(row.expires_at.timestamp()) if row.expires_at else None,
    }


@router.post("/sessions")
def start_job(req: StartJobRequest, principal: RequirePrincipal) -> dict:
    try:
        result = start_session(
            principal,
            vin=req.vin,
            authorisation_id=req.authorisation_id,
            oem=req.oem,
            operation=req.operation,
            device_id=req.device_id,
            device_tier=req.device_tier,
            ttl_s=req.ttl_s,
        )
    except ImmoDenied as exc:
        record = getattr(exc, "detail", "")
        if "already active" in record:
            inc("immo_session_conflict")
        _raise(exc)
        raise
    inc("immo_session_started")
    return result


@router.post("/sessions/{session_id}/token")
def get_token(session_id: UUID, principal: RequirePrincipal) -> dict:
    try:
        result = fetch_token(principal, session_id)
    except ImmoDenied as exc:
        _raise(exc)
        raise
    inc("immo_token_fetched")
    return result


@router.post("/sessions/{session_id}/complete")
def complete(session_id: UUID, principal: RequirePrincipal) -> dict:
    try:
        result = complete_or_abort(principal, session_id, abort=False)
    except ImmoDenied as exc:
        _raise(exc)
        raise
    inc("immo_session_completed")
    return result


@router.post("/sessions/{session_id}/abort")
def abort(session_id: UUID, principal: RequirePrincipal) -> dict:
    try:
        result = complete_or_abort(principal, session_id, abort=True)
    except ImmoDenied as exc:
        _raise(exc)
        raise
    inc("immo_session_aborted")
    return result


@router.get("/sessions/{session_id}")
def read_session(session_id: UUID, principal: RequirePrincipal) -> dict:
    try:
        return get_session(principal, session_id)
    except ImmoDenied as exc:
        _raise(exc)
        raise
