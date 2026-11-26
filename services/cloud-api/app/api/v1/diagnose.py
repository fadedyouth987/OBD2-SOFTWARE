"""KG-guided diagnosis, vehicle registry, and copilot endpoints (Task 3.3)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.deps import RequirePrincipal
from app.api.v1.sessions import find_similar_cases
from app.db.models import DiagnosticSession
from app.db.session import tenant_session
from app.db.vin import wmi_vds
from app.observability.metrics import inc
from app.services.ai_diagnostic_agent import (
    answer_technician_followup,
    diagnose_session,
    llm_diagnosis,
    llm_followup,
)
from app.services.billing import charge_ai_quota, refund_ai_quota
from app.services.llm import LlmError, configured_llm
from app.services.procedures import Vehicle
from app.services.service_procedures import service_functions_for
from app.services.vehicle_registry import (
    SERVICE_FUNCTIONS_CATALOG,
    VEHICLE_PLATFORMS,
    decode_vin_platform,
    get_vehicle_platform,
    list_vehicle_platforms,
)

router = APIRouter(prefix="/api/v1", tags=["diagnose"])
log = logging.getLogger(__name__)


class DiagnoseRequest(BaseModel):
    """Only what the technician knows. Circuit nodes and resolved cases are always
    looked up here, never taken from the client, so the model can only cite real
    evidence (A-CEO-1, A-DES-4)."""

    dtcs: list[str]
    vehicle_profile: str = "generic_obd2_uds"


class FollowupRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    vehicle_profile: str = "generic_obd2_uds"
    dtcs: list[str] = []


class DecodeVinRequest(BaseModel):
    vin: str = Field(min_length=8, max_length=32)


def _redacted(vin: str) -> str:
    cleaned = vin.strip().upper()
    try:
        return wmi_vds(cleaned) + "•" * max(0, len(cleaned) - 9)
    except Exception:
        return "[VIN_REDACTED]"


@router.get("/vehicles")
def get_vehicles() -> dict[str, Any]:
    platforms = list_vehicle_platforms()
    return {
        "obd2_protocol_coverage": (
            "Universal OBD-II/EOBD (CAN 11/29-bit, KWP2000, ISO 9141-2, J1850 PWM/VPW) "
            "— 80+ global makes"
        ),
        "oem_platform_count": len(platforms),
        "platforms": platforms,
        "service_functions": SERVICE_FUNCTIONS_CATALOG,
    }


@router.post("/vehicles/decode")
def decode_vin(req: DecodeVinRequest, principal: RequirePrincipal) -> dict[str, Any]:
    vin = req.vin.strip().upper()
    log.info("vin decode requested wmi_vds=%s tenant=%s", _redacted(vin), principal.tenant_id)
    return decode_vin_platform(vin)


@router.get("/vehicles/decode/{vin}")
def decode_vin_get_removed(vin: str) -> dict[str, Any]:
    # VIN in a URL is logged by proxies; the supported API is POST /vehicles/decode.
    raise HTTPException(
        status_code=status.HTTP_405_METHOD_NOT_ALLOWED,
        detail="VIN decode is only available via POST /api/v1/vehicles/decode",
    )


@router.get("/vehicles/{profile}/services")
def get_vehicle_services(profile: str) -> dict[str, Any]:
    if profile not in VEHICLE_PLATFORMS:
        raise HTTPException(status_code=404, detail=f"Unknown vehicle profile {profile!r}")
    info = get_vehicle_platform(profile)
    return {
        "profile": profile,
        "vehicle": f"{info['make']} {info['model']}",
        "modules": info["modules"],
        "service_functions": SERVICE_FUNCTIONS_CATALOG,
    }


@router.get("/service-functions")
def get_service_functions(
    principal: RequirePrincipal,
    adapter_id: str | None = Query(default=None, max_length=128),
    job_id: UUID | None = None,
) -> dict[str, Any]:
    """Service functions with a runnable procedure where one is on file.

    Virtual adapters get the simulator's procedures; a real vehicle gets
    licensed procedures matched on the job's make, model and model year.
    """
    vehicle = None
    if job_id is not None:
        with tenant_session(principal.tenant_id) as store:
            job = store.get(DiagnosticSession, job_id)
            if job is None or job.tenant_id != principal.tenant_id:
                raise HTTPException(status_code=404, detail="Session not found")
            if job.vehicle_make or job.vehicle_model or job.model_year:
                vehicle = Vehicle(
                    make=job.vehicle_make or "",
                    model=job.vehicle_model or "",
                    year=job.model_year,
                )
    return service_functions_for(adapter_id, vehicle)


# Why a diagnosis came from the rules rather than the model (shown in the UI).
FALLBACK_TEXT = {
    "not_configured": "No AI model is set up on this server, so the built-in rules ran.",
    "quota_exhausted": (
        "This month's AI diagnoses are used up, so the built-in rules ran. "
        "Rule-based results don't count against your quota."
    ),
    "llm_error": "The AI model didn't answer in time, so the built-in rules ran.",
}


def run_with_quota(principal, rules: dict[str, Any], call_llm) -> dict[str, Any]:
    """Run the model when there is one and quota left; otherwise return the rules.

    One diagnosis is reserved before the model is called and refunded if it
    fails, so only a delivered model answer counts. Rule results are free.
    """
    provider = configured_llm()
    reason: str | None = None
    used = limit = None
    charged = False
    result = rules
    if provider is None:
        reason = "not_configured"
    else:
        charged, used, limit = charge_ai_quota(principal.tenant_id)
        if not charged:
            reason = "quota_exhausted"
        else:
            try:
                result = call_llm(provider)
            except LlmError as exc:
                log.warning("AI model failed for tenant=%s: %s", principal.tenant_id, exc)
                inc("ai_llm_failed")
                used = refund_ai_quota(principal.tenant_id)
                charged = False
                reason = "llm_error"
                result = rules
    if charged:
        inc("ai_llm_answers")
    else:
        inc("ai_rules_answers")
    result = dict(result)
    result["quota_charged"] = charged
    result["fallback_reason"] = reason
    result["fallback_text"] = FALLBACK_TEXT.get(reason or "")
    result["quota_used"] = used
    result["quota_limit"] = limit
    return result


@router.post("/diagnose/{session_id}")
def run_diagnosis(
    session_id: str, req: DiagnoseRequest, principal: RequirePrincipal
) -> dict[str, Any]:
    inc("ai_diagnose_requests")
    engine_family = str(get_vehicle_platform(req.vehicle_profile).get("engine") or "")
    cases = find_similar_cases(principal.tenant_id, req.dtcs, engine_family)
    rules = diagnose_session(
        session_id=session_id,
        dtcs=req.dtcs,
        matched_cases=cases,
        vehicle_profile=req.vehicle_profile,
    )
    result = run_with_quota(
        principal,
        rules,
        lambda provider: llm_diagnosis(provider, rules, req.dtcs, req.vehicle_profile),
    )
    _attach_diagnosis(principal, session_id, req, result)
    return result


def _attach_diagnosis(principal, session_id: str, req: DiagnoseRequest, result: dict) -> None:
    """Keep the latest diagnosis on the open job so the report and close-out can use it."""
    try:
        job_id = UUID(session_id)
    except ValueError:
        return
    with tenant_session(principal.tenant_id) as store:
        row = (
            store.query(DiagnosticSession)
            .filter(
                DiagnosticSession.tenant_id == principal.tenant_id,
                DiagnosticSession.id == job_id,
            )
            .one_or_none()
        )
        if row is None or row.status != "OPEN":
            return
        row.diagnosis = {
            "dtcs": list(req.dtcs),
            "vehicle_profile": req.vehicle_profile,
            "result": {k: v for k, v in result.items() if k not in {"quota_used", "quota_limit"}},
            "at": datetime.now(UTC).isoformat(),
        }


@router.post("/diagnose/{session_id}/ask")
def ask_copilot(
    session_id: str, req: FollowupRequest, principal: RequirePrincipal
) -> dict[str, Any]:
    inc("ai_copilot_followups")
    rules = answer_technician_followup(
        session_id=session_id,
        question=req.question,
        vehicle_profile=req.vehicle_profile,
        dtcs=req.dtcs,
    )
    return run_with_quota(
        principal,
        rules,
        lambda provider: llm_followup(provider, rules, req.question, req.vehicle_profile, req.dtcs),
    )
