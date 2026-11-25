"""Idempotent session sync and resolved-case publish (Task 2.2, A-CEO-6)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from app.api.deps import RequirePrincipal
from app.db.models import (
    AuditLogEntry,
    DiagnosticSession,
    ResolvedCase,
    SyncBatch,
    TelemetrySample,
)
from app.db.session import tenant_session
from app.observability.metrics import inc
from app.services.anonymizer import anonymize_audit_entry, anonymize_case, anonymize_telemetry_row
from app.services.embeddings import EMBEDDING_MODEL, embed_canonical_text

router = APIRouter(prefix="/api/v1", tags=["sessions"])

_AUDIT_OUTCOMES = {
    "allowed",
    "refused",
    "response",
    "logged",
    "token_issued",
    "token_refused",
    "bench_mode",
}
_AUDIT_OUTCOME_ALIASES = {
    "approved": "allowed",
    "ok": "allowed",
    "success": "allowed",
    "denied": "refused",
    "rejected": "refused",
    "error": "refused",
    "failed": "refused",
    "pending": "logged",
}


def _audit_outcome(value: str) -> str:
    key = value.strip().lower()
    if key in _AUDIT_OUTCOMES:
        return key
    return _AUDIT_OUTCOME_ALIASES.get(key, "logged")


def _as_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(UTC)


def _get_or_create_session(
    store, tenant_id: UUID, user_id: UUID, edge_session_id: str
) -> DiagnosticSession:
    existing = (
        store.query(DiagnosticSession)
        .filter(
            DiagnosticSession.tenant_id == tenant_id,
            DiagnosticSession.edge_session_id == edge_session_id,
        )
        .one_or_none()
    )
    if existing is not None:
        return existing
    row = DiagnosticSession(
        id=uuid4(),
        tenant_id=tenant_id,
        user_id=user_id,
        edge_session_id=edge_session_id,
        summary={"watermark_us": 0},
    )
    store.add(row)
    store.flush()
    return row


def list_published_cases(tenant_id: UUID, dtcs: list[str] | None = None) -> list[dict[str, Any]]:
    with tenant_session(tenant_id) as session:
        rows = session.query(ResolvedCase).all()
        items = [_case_to_dict(c) for c in rows]
    if not dtcs:
        return items
    wanted = {d.upper() for d in dtcs}
    return [c for c in items if any(str(code).upper() in wanted for code in c.get("dtcs", []))]


def _case_to_dict(row: ResolvedCase) -> dict[str, Any]:
    return {
        "case_id": str(row.id),
        "wmi_vds": row.wmi_vds,
        "engine_family": row.engine_family,
        "dtcs": list(row.dtcs or []),
        "symptom_summary": row.canonical_summary,
        "verified_fix": row.fix_description,
    }


class SyncBatchRequest(BaseModel):
    batch_id: str
    session_id: str
    watermark_us: int
    telemetry_rows: list[dict[str, Any]] = []
    audit_entries: list[dict[str, Any]] = []
    # Ignored: tenant is taken from the session, never the body.
    tenant_id: str | None = None


class PublishCaseRequest(BaseModel):
    vin: str = ""
    wmi_vds: str = ""
    engine_family: str
    dtcs: list[str]
    symptom_summary: str
    verified_fix: str
    parts_replaced: list[str] = []


@router.post("/sessions/sync")
def sync_session_batch(req: SyncBatchRequest, principal: RequirePrincipal) -> dict[str, Any]:
    try:
        with tenant_session(principal.tenant_id) as store:
            if store.get(SyncBatch, (principal.tenant_id, req.batch_id)) is not None:
                inc("sessions_sync_deduped")
                return {
                    "status": "duplicate_ignored",
                    "batch_id": req.batch_id,
                    "watermark_us": req.watermark_us,
                }
            sess = _get_or_create_session(
                store, principal.tenant_id, principal.user_id, req.session_id
            )
            summary = dict(sess.summary or {})
            summary["watermark_us"] = max(int(summary.get("watermark_us") or 0), req.watermark_us)
            sess.summary = summary

            telemetry_ingested = 0
            for raw in req.telemetry_rows:
                row = anonymize_telemetry_row(raw)
                try:
                    pid = int(row.get("pid", 0))
                    value = float(row.get("value", 0.0))
                except (TypeError, ValueError):
                    continue
                sample = TelemetrySample(
                    time=_as_datetime(row.get("time")),
                    tenant_id=principal.tenant_id,
                    session_id=sess.id,
                    pid=pid,
                    name=str(row.get("name") or f"pid_{pid}"),
                    value=value,
                    unit=str(row.get("unit") or ""),
                )
                store.add(sample)
                telemetry_ingested += 1

            audit_ingested = 0
            for index, raw in enumerate(req.audit_entries):
                entry = anonymize_audit_entry(raw)
                try:
                    seq = int(entry.get("seq", index + 1))
                except (TypeError, ValueError):
                    seq = index + 1
                store.add(
                    AuditLogEntry(
                        tenant_id=principal.tenant_id,
                        edge_session_id=req.session_id,
                        seq=seq,
                        at=_as_datetime(entry.get("at")),
                        user_ref=str(entry.get("user_ref") or principal.user_id),
                        vehicle_ref=str(entry.get("vehicle_ref") or ""),
                        ecu=str(entry.get("ecu") or "UNKNOWN")[:64] or "UNKNOWN",
                        service=str(entry.get("service") or entry.get("action") or "UNKNOWN")[:64],
                        tier=str(entry.get("tier") or "A")[:1],
                        outcome=_audit_outcome(
                            str(entry.get("outcome") or entry.get("status") or "logged")
                        ),
                        code=str(entry.get("code") or "") or None,
                        nrc=int(entry["nrc"]) if str(entry.get("nrc") or "").isdigit() else None,
                        detail=str(entry.get("detail") or ""),
                    )
                )
                audit_ingested += 1

            store.add(
                SyncBatch(
                    tenant_id=principal.tenant_id,
                    batch_id=req.batch_id,
                    edge_session_id=req.session_id,
                    session_id=sess.id,
                    watermark_us=req.watermark_us,
                )
            )
    except IntegrityError as exc:
        with tenant_session(principal.tenant_id) as store:
            if store.get(SyncBatch, (principal.tenant_id, req.batch_id)) is not None:
                inc("sessions_sync_deduped")
                return {
                    "status": "duplicate_ignored",
                    "batch_id": req.batch_id,
                    "watermark_us": req.watermark_us,
                }
        raise HTTPException(status_code=409, detail="session sync conflict") from exc

    inc("sessions_sync_accepted")
    return {
        "status": "accepted",
        "batch_id": req.batch_id,
        "telemetry_ingested": telemetry_ingested,
        "audit_ingested": audit_ingested,
        "watermark_us": req.watermark_us,
    }


@router.get("/sessions/{session_id}")
def get_session(session_id: str, principal: RequirePrincipal) -> dict[str, Any]:
    with tenant_session(principal.tenant_id) as store:
        sess = (
            store.query(DiagnosticSession)
            .filter(
                DiagnosticSession.tenant_id == principal.tenant_id,
                DiagnosticSession.edge_session_id == session_id,
            )
            .one_or_none()
        )
        if sess is None:
            raise HTTPException(status_code=404, detail="Session not found")
        telemetry = store.query(TelemetrySample).filter(TelemetrySample.session_id == sess.id).all()
        audit = store.query(AuditLogEntry).filter(AuditLogEntry.edge_session_id == session_id).all()
        return {
            "session_id": session_id,
            "tenant_id": str(sess.tenant_id),
            "watermark_us": int((sess.summary or {}).get("watermark_us") or 0),
            "telemetry_rows": [
                {
                    "time": row.time.isoformat(),
                    "pid": row.pid,
                    "name": row.name,
                    "value": row.value,
                    "unit": row.unit,
                }
                for row in telemetry
            ],
            "audit_entries": [
                {
                    "seq": row.seq,
                    "ecu": row.ecu,
                    "service": row.service,
                    "outcome": row.outcome,
                    "detail": row.detail,
                }
                for row in audit
            ],
        }


@router.post("/cases/publish")
def publish_resolved_case(req: PublishCaseRequest, principal: RequirePrincipal) -> dict[str, Any]:
    scrubbed = anonymize_case(req.model_dump() if hasattr(req, "model_dump") else req.dict())
    canonical = " ".join(
        [
            scrubbed.get("wmi_vds") or "",
            scrubbed.get("engine_family") or "",
            " ".join(scrubbed.get("dtcs") or []),
            scrubbed.get("symptom_summary") or "",
        ]
    )
    vector = embed_canonical_text(canonical)
    case_id = uuid4()
    with tenant_session(principal.tenant_id) as store:
        row = ResolvedCase(
            id=case_id,
            wmi_vds=scrubbed.get("wmi_vds") or None,
            engine_family=scrubbed.get("engine_family") or None,
            dtcs=list(scrubbed.get("dtcs") or []),
            canonical_summary=str(scrubbed.get("symptom_summary") or ""),
            fix_description=str(scrubbed.get("verified_fix") or ""),
            feature_vector=None,
            embedding=vector,
            embedding_model=EMBEDDING_MODEL,
        )
        store.add(row)
    inc("cases_published")
    record = {"case_id": str(case_id), **scrubbed}
    return {"status": "published", "case": record}


@router.get("/cases")
def get_cases(principal: RequirePrincipal, dtc: str | None = Query(default=None)) -> dict[str, Any]:
    items = list_published_cases(principal.tenant_id, [dtc] if dtc else None)
    return {"total": len(items), "cases": items}
