"""KG-guided RAG root-cause diagnosis, vehicle registry & interactive copilot endpoints (Task 3.3)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.v1.sessions import list_published_cases
from app.observability.metrics import inc
from app.services.ai_diagnostic_agent import answer_technician_followup, diagnose_session
from app.services.vehicle_registry import (
    SERVICE_FUNCTIONS_CATALOG,
    decode_vin_platform,
    get_vehicle_platform,
    list_vehicle_platforms,
)

router = APIRouter(prefix="/api/v1", tags=["diagnose"])


class DiagnoseRequest(BaseModel):
    dtcs: list[str]
    vehicle_profile: str = "ford_ranger_px3"
    shared_graph_nodes: list[str] | None = None
    matched_cases: list[dict[str, Any]] | None = None
    llm_error: str | None = None


class FollowupRequest(BaseModel):
    question: str
    vehicle_profile: str = "ford_ranger_px3"
    dtcs: list[str] = []
    llm_error: str | None = None


@router.get("/vehicles")
def get_vehicles() -> dict[str, Any]:
    platforms = list_vehicle_platforms()
    return {
        "obd2_protocol_coverage": "Universal OBD-II/EOBD (CAN 11/29-bit, KWP2000, ISO 9141-2, J1850 PWM/VPW) — 80+ global makes",
        "oem_platform_count": len(platforms),
        "platforms": platforms,
        "service_functions": SERVICE_FUNCTIONS_CATALOG,
    }


@router.get("/vehicles/decode/{vin}")
def decode_vin(vin: str) -> dict[str, Any]:
    return decode_vin_platform(vin)


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
def run_diagnosis(session_id: str, req: DiagnoseRequest) -> dict[str, Any]:
    inc("ai_diagnose_requests")
    cases = req.matched_cases if req.matched_cases is not None else list_published_cases(req.dtcs)
    return diagnose_session(
        session_id=session_id,
        dtcs=req.dtcs,
        shared_graph_nodes=req.shared_graph_nodes,
        matched_cases=cases,
        llm_error=req.llm_error,
        vehicle_profile=req.vehicle_profile,
    )


@router.post("/diagnose/{session_id}/ask")
def ask_copilot(session_id: str, req: FollowupRequest) -> dict[str, Any]:
    inc("ai_copilot_followups")
    return answer_technician_followup(
        session_id=session_id,
        question=req.question,
        vehicle_profile=req.vehicle_profile,
        dtcs=req.dtcs,
        llm_error=req.llm_error,
    )
