"""KG-guided diagnosis, vehicle registry, and copilot endpoints (Task 3.3)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import RequirePrincipal
from app.api.v1.billing import charge_ai_quota
from app.api.v1.sessions import list_published_cases
from app.db.models import DiagnosticSession
from app.db.session import tenant_session
from app.db.vin import wmi_vds
from app.observability.metrics import inc
from app.services.ai_diagnostic_agent import answer_technician_followup, diagnose_session
from app.services.vehicle_registry import (
    SERVICE_FUNCTIONS_CATALOG,
    decode_vin_platform,
    get_vehicle_platform,
    list_vehicle_platforms,
)

router = APIRouter(prefix="/api/v1", tags=["diagnose"])
log = logging.getLogger(__name__)


class DiagnoseRequest(BaseModel):
    dtcs: list[str]
    vehicle_profile: str = "ford_ranger_px3"
    shared_graph_nodes: list[str] | None = None
    matched_cases: list[dict[str, Any]] | None = None


class FollowupRequest(BaseModel):
    question: str
    vehicle_profile: str = "ford_ranger_px3"
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
    info = get_vehicle_platform(profile)
    return {
        "profile": profile,
        "vehicle": f"{info['make']} {info['model']}",
        "modules": info["modules"],
        "service_functions": SERVICE_FUNCTIONS_CATALOG,
    }


@router.post("/diagnose/{session_id}")
def run_diagnosis(
    session_id: str, req: DiagnoseRequest, principal: RequirePrincipal
) -> dict[str, Any]:
    inc("ai_diagnose_requests")
    cases = (
        req.matched_cases
        if req.matched_cases is not None
        else list_published_cases(principal.tenant_id, req.dtcs)
    )
    charged, used, limit = charge_ai_quota(principal.tenant_id)
    if not charged:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "AI diagnosis monthly quota exceeded",
                "used": used,
                "limit": limit,
            },
        )
    result = diagnose_session(
        session_id=session_id,
        dtcs=req.dtcs,
        shared_graph_nodes=req.shared_graph_nodes,
        matched_cases=cases,
        vehicle_profile=req.vehicle_profile,
    )
    result["quota_charged"] = True
    result["quota_used"] = used
    result["quota_limit"] = limit
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
            "result": {k: v for k, v in result.items() if not k.startswith("quota_")},
            "at": datetime.now(UTC).isoformat(),
        }


@router.post("/diagnose/{session_id}/ask")
def ask_copilot(
    session_id: str, req: FollowupRequest, principal: RequirePrincipal
) -> dict[str, Any]:
    inc("ai_copilot_followups")
    charged, used, limit = charge_ai_quota(principal.tenant_id)
    if not charged:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "message": "AI diagnosis monthly quota exceeded",
                "used": used,
                "limit": limit,
            },
        )
    result = answer_technician_followup(
        session_id=session_id,
        question=req.question,
        vehicle_profile=req.vehicle_profile,
        dtcs=req.dtcs,
    )
    result["quota_charged"] = True
    result["quota_used"] = used
    result["quota_limit"] = limit
    return result
