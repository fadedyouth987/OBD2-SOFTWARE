"""Diagnostic session workflow: start, update, list, close out, report.

A "session" here is one vehicle job in the workshop. It survives daemon
reconnects: the app keeps the session id and re-attaches. The first daemon
session id is kept as ``edge_session_id`` so telemetry synced through
``POST /sessions/sync`` lands on the same job.

The full VIN is never stored, only the HMAC (to recognise the same car) and the
redacted WMI+VDS form shown in the UI and report.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func

from app.api.deps import RequirePrincipal
from app.config import get_settings
from app.db.models import (
    AuditLogEntry,
    DiagnosticSession,
    ResolvedCase,
    TelemetrySample,
)
from app.db.session import tenant_session
from app.db.vin import normalize_vin, resolve_secret, vin_hmac
from app.observability.metrics import inc
from app.services.anonymizer import anonymize_case, scrub_text
from app.services.embeddings import EMBEDDING_MODEL, embed_canonical_text
from app.services.identity import user_profile

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])

_DTC = re.compile(r"^[PCBU][0-3][0-9A-F]{3}$")
MAX_DTCS = 200
MAX_ALERTS = 50


class DtcIn(BaseModel):
    code: str = Field(max_length=8)
    module: str = Field(default="", max_length=64)
    status: str = Field(default="", max_length=32)
    source: str = Field(default="", max_length=32)
    description: str = Field(default="", max_length=200)
    status_byte: int | None = Field(default=None, ge=0, le=255)


class AlertIn(BaseModel):
    rule_id: str = Field(max_length=64)
    severity: Literal["INFO", "AMBER", "RED"]
    title: str = Field(max_length=200)
    recommended_test: str = Field(default="", max_length=1000)
    evidence_json: dict[str, Any] = {}


class JobStart(BaseModel):
    edge_session_id: str | None = Field(default=None, max_length=64)
    vin: str | None = Field(default=None, max_length=32)
    vehicle_label: str | None = Field(default=None, max_length=200)
    vehicle_profile: str | None = Field(default=None, max_length=64)
    protocol: str | None = Field(default=None, max_length=32)
    adapter_id: str | None = Field(default=None, max_length=128)
    adapter_kind: str | None = Field(default=None, max_length=32)
    daemon_version: str | None = Field(default=None, max_length=32)
    lease_tier: str | None = Field(default=None, max_length=16)
    odometer_km: int | None = Field(default=None, ge=0, le=2_000_000)
    customer_ref: str | None = Field(default=None, max_length=120)
    complaint: str | None = Field(default=None, max_length=2000)


class JobUpdate(BaseModel):
    vin: str | None = Field(default=None, max_length=32)
    vehicle_label: str | None = Field(default=None, max_length=200)
    vehicle_profile: str | None = Field(default=None, max_length=64)
    odometer_km: int | None = Field(default=None, ge=0, le=2_000_000)
    customer_ref: str | None = Field(default=None, max_length=120)
    complaint: str | None = Field(default=None, max_length=2000)
    dtcs: list[DtcIn] | None = None
    alerts: list[AlertIn] | None = None
    diagnosis: dict[str, Any] | None = None


class JobClose(BaseModel):
    summary: str = Field(min_length=3, max_length=4000)
    actual_fix: str = Field(min_length=3, max_length=4000)
    parts_replaced: list[str] = Field(default_factory=list, max_length=50)
    labour_notes: str = Field(default="", max_length=4000)
    recommendations: str = Field(default="", max_length=4000)
    dtcs_cleared: bool = False
    publish_case: bool = False
    engine_family: str = Field(default="", max_length=120)


def _vin_fields(vin: str | None) -> tuple[str | None, str | None]:
    if not vin:
        return None, None
    try:
        clean = normalize_vin(vin)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    key = resolve_secret(get_settings().vin_hmac_key_ref)
    return vin_hmac(clean, key), clean[:9] + "•" * 8


def _clean_dtcs(items: list[DtcIn]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for d in items[:MAX_DTCS]:
        code = d.code.strip().upper()
        if not _DTC.fullmatch(code):
            raise HTTPException(status_code=422, detail=f"{d.code!r} is not a DTC like P0171")
        key = (code, d.module)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "code": code,
                "module": d.module,
                "status": d.status,
                "source": d.source,
                "description": scrub_text(d.description),
                "status_byte": d.status_byte,
            }
        )
    return out


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _job_dict(row: DiagnosticSession) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "edge_session_id": row.edge_session_id,
        "status": row.status,
        "vehicle_label": row.vehicle_label,
        "vehicle_profile": row.vehicle_profile,
        "vin_redacted": row.vin_redacted,
        "odometer_km": row.odometer_km,
        "protocol": row.protocol,
        "adapter_id": row.adapter_id,
        "adapter_kind": row.adapter_kind,
        "daemon_version": row.daemon_version,
        "lease_tier": row.lease_tier,
        "customer_ref": row.customer_ref,
        "complaint": row.complaint,
        "dtcs": list(row.dtcs or []),
        "alerts": list(row.alerts or []),
        "diagnosis": row.diagnosis,
        "closeout": row.closeout,
        "started_at": _iso(row.started_at),
        "ended_at": _iso(row.ended_at),
        "updated_at": _iso(row.updated_at),
        "user_id": str(row.user_id) if row.user_id else None,
    }


def _get(store, tenant_id: UUID, job_id: str) -> DiagnosticSession:
    try:
        jid = UUID(job_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Session not found") from exc
    row = (
        store.query(DiagnosticSession)
        .filter(DiagnosticSession.tenant_id == tenant_id, DiagnosticSession.id == jid)
        .one_or_none()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return row


@router.post("", status_code=201)
def start_job(req: JobStart, principal: RequirePrincipal) -> dict[str, Any]:
    hmac_value, redacted = _vin_fields(req.vin)
    with tenant_session(principal.tenant_id) as store:
        if req.edge_session_id:
            existing = (
                store.query(DiagnosticSession)
                .filter(
                    DiagnosticSession.tenant_id == principal.tenant_id,
                    DiagnosticSession.edge_session_id == req.edge_session_id,
                )
                .one_or_none()
            )
            if existing is not None:
                return _job_dict(existing)
        row = DiagnosticSession(
            id=uuid4(),
            tenant_id=principal.tenant_id,
            user_id=principal.user_id,
            edge_session_id=req.edge_session_id,
            protocol=req.protocol,
            summary={"watermark_us": 0},
            status="OPEN",
            vehicle_label=req.vehicle_label,
            vehicle_profile=req.vehicle_profile,
            vin_hmac=hmac_value,
            vin_redacted=redacted,
            odometer_km=req.odometer_km,
            adapter_id=req.adapter_id,
            adapter_kind=req.adapter_kind,
            daemon_version=req.daemon_version,
            lease_tier=req.lease_tier,
            customer_ref=scrub_text(req.customer_ref) if req.customer_ref else None,
            complaint=req.complaint,
            dtcs=[],
            alerts=[],
        )
        store.add(row)
        store.flush()
        store.refresh(row)
        inc("jobs_started")
        return _job_dict(row)


@router.get("")
def list_jobs(
    principal: RequirePrincipal,
    status_filter: Literal["OPEN", "CLOSED"] | None = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict[str, Any]:
    with tenant_session(principal.tenant_id) as store:
        q = store.query(DiagnosticSession).filter(
            DiagnosticSession.tenant_id == principal.tenant_id
        )
        if status_filter:
            q = q.filter(DiagnosticSession.status == status_filter)
        rows = q.order_by(DiagnosticSession.started_at.desc()).limit(limit).all()
        counts = dict(
            store.query(DiagnosticSession.status, func.count())
            .filter(DiagnosticSession.tenant_id == principal.tenant_id)
            .group_by(DiagnosticSession.status)
            .all()
        )
        return {
            "jobs": [_job_dict(r) for r in rows],
            "open": int(counts.get("OPEN", 0)),
            "closed": int(counts.get("CLOSED", 0)),
        }


@router.get("/{job_id}")
def get_job(job_id: str, principal: RequirePrincipal) -> dict[str, Any]:
    with tenant_session(principal.tenant_id) as store:
        return _job_dict(_get(store, principal.tenant_id, job_id))


@router.patch("/{job_id}")
def update_job(job_id: str, req: JobUpdate, principal: RequirePrincipal) -> dict[str, Any]:
    with tenant_session(principal.tenant_id) as store:
        row = _get(store, principal.tenant_id, job_id)
        if row.status != "OPEN":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This session is closed. Start a new session to make changes.",
            )
        fields = req.model_fields_set
        if "vin" in fields:
            row.vin_hmac, row.vin_redacted = _vin_fields(req.vin)
        for name in ("vehicle_label", "vehicle_profile", "odometer_km", "complaint"):
            if name in fields:
                setattr(row, name, getattr(req, name))
        if "customer_ref" in fields:
            row.customer_ref = scrub_text(req.customer_ref) if req.customer_ref else None
        if req.dtcs is not None:
            row.dtcs = _clean_dtcs(req.dtcs)
        if req.alerts is not None:
            row.alerts = [a.model_dump() for a in req.alerts[:MAX_ALERTS]]
        if "diagnosis" in fields:
            row.diagnosis = req.diagnosis
        row.updated_at = datetime.now(UTC)
        store.flush()
        return _job_dict(row)


@router.post("/{job_id}/close")
def close_job(job_id: str, req: JobClose, principal: RequirePrincipal) -> dict[str, Any]:
    case_id: str | None = None
    with tenant_session(principal.tenant_id) as store:
        row = _get(store, principal.tenant_id, job_id)
        if row.status != "OPEN":
            raise HTTPException(status_code=409, detail="This session is already closed")
        parts = [scrub_text(p.strip())[:120] for p in req.parts_replaced if p.strip()]
        codes = sorted({d.get("code", "") for d in (row.dtcs or []) if d.get("code")})
        if req.publish_case:
            if not codes:
                raise HTTPException(
                    status_code=422,
                    detail="Read the DTCs before publishing a case: a case needs at least one",
                )
            scrubbed = anonymize_case(
                {
                    "wmi_vds": (row.vin_redacted or "")[:9] or "UNKNOWN",
                    "engine_family": req.engine_family or row.vehicle_label or "unknown",
                    "dtcs": codes,
                    "symptom_summary": req.summary,
                    "verified_fix": req.actual_fix,
                    "parts_replaced": parts,
                }
            )
            canonical = " ".join(
                [
                    scrubbed["wmi_vds"],
                    scrubbed["engine_family"],
                    " ".join(scrubbed["dtcs"]),
                    scrubbed["symptom_summary"],
                ]
            )
            case = ResolvedCase(
                id=uuid4(),
                wmi_vds=scrubbed["wmi_vds"],
                engine_family=scrubbed["engine_family"],
                dtcs=scrubbed["dtcs"],
                canonical_summary=scrubbed["symptom_summary"],
                fix_description=scrubbed["verified_fix"],
                feature_vector=None,
                embedding=embed_canonical_text(canonical),
                embedding_model=EMBEDDING_MODEL,
            )
            store.add(case)
            case_id = str(case.id)
            inc("cases_published")
        now = datetime.now(UTC)
        row.closeout = {
            "summary": scrub_text(req.summary),
            "actual_fix": scrub_text(req.actual_fix),
            "parts_replaced": parts,
            "labour_notes": scrub_text(req.labour_notes),
            "recommendations": scrub_text(req.recommendations),
            "dtcs_cleared": req.dtcs_cleared,
            "case_id": case_id,
            "closed_by": str(principal.user_id),
            "closed_at": now.isoformat(),
        }
        row.status = "CLOSED"
        row.ended_at = now
        row.updated_at = now
        store.flush()
        inc("jobs_closed")
        return _job_dict(row)


@router.get("/{job_id}/report")
def job_report(job_id: str, principal: RequirePrincipal) -> dict[str, Any]:
    """Data for the printable customer report."""
    with tenant_session(principal.tenant_id) as store:
        row = _get(store, principal.tenant_id, job_id)
        job = _job_dict(row)
        owner_id = row.user_id
        telemetry_count = 0
        pid_summary: list[dict[str, Any]] = []
        if row.edge_session_id:
            stats = (
                store.query(
                    TelemetrySample.pid,
                    TelemetrySample.name,
                    TelemetrySample.unit,
                    func.count(),
                    func.min(TelemetrySample.value),
                    func.max(TelemetrySample.value),
                    func.avg(TelemetrySample.value),
                )
                .filter(TelemetrySample.session_id == row.id)
                .group_by(TelemetrySample.pid, TelemetrySample.name, TelemetrySample.unit)
                .all()
            )
            for pid, name, unit, n, lo, hi, avg in stats:
                telemetry_count += int(n)
                pid_summary.append(
                    {
                        "pid": pid,
                        "name": name,
                        "unit": unit,
                        "samples": int(n),
                        "min": float(lo),
                        "max": float(hi),
                        "avg": round(float(avg), 2),
                    }
                )
            audit = [
                {
                    "seq": a.seq,
                    "at": _iso(a.at),
                    "ecu": a.ecu,
                    "service": a.service,
                    "tier": a.tier,
                    "outcome": a.outcome,
                }
                for a in store.query(AuditLogEntry)
                .filter(AuditLogEntry.edge_session_id == row.edge_session_id)
                .order_by(AuditLogEntry.seq)
                .all()
            ]
        else:
            audit = []
    tech = user_profile(owner_id) if owner_id else None
    return {
        "job": job,
        "workshop": {"name": principal.tenant_name},
        "technician": {"display_name": (tech or {}).get("display_name")},
        "telemetry": {"samples": telemetry_count, "pids": pid_summary},
        "actions": audit,
        "generated_at": datetime.now(UTC).isoformat(),
    }
