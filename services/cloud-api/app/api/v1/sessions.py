"""Idempotent session sync and resolved-case publish (Task 2.2, A-CEO-6)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import Text, literal, text
from sqlalchemy.dialects.postgresql import ARRAY as PG_ARRAY
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Engine
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
from app.observability.metrics import count, inc, observe
from app.services import can_traces
from app.services.anonymizer import anonymize_audit_entry, anonymize_case, anonymize_telemetry_row
from app.services.embeddings import EMBEDDING_MODEL, cosine_similarity, embed_canonical_text

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


CASE_MATCH_LIMIT = 5
# Second-pass ceiling when the indexed search comes back short (A-ENG-7).
_WIDEN_CANDIDATES = 500
# Nearest neighbours fetched from the index before re-ranking.
_POOL_FACTOR = 8


def case_query_text(engine_family: str, dtcs: list[str]) -> str:
    """The text a case is embedded from at publish time, minus what a diagnosis can't know."""
    return " ".join(["", engine_family or "", " ".join(dtcs), ""])


def find_similar_cases(
    tenant_id: UUID,
    dtcs: list[str],
    engine_family: str = "",
    limit: int = CASE_MATCH_LIMIT,
    engine: Engine | None = None,
) -> list[dict[str, Any]]:
    """The resolved cases closest to this diagnosis, found server-side (A-ENG-7).

    Eligible cases share at least one DTC. A filtered HNSW search can return
    fewer rows than exist, so iterative index scans are switched on (pgvector
    0.8+; a harmless placeholder setting on older versions) and, if the result
    is still short, a second exact pass reads every eligible row. Candidates
    are then ranked by codes in common, same engine family, embedding
    similarity and recency, so a growing corpus can't push the closest case out.
    """
    wanted = sorted({d.strip().upper() for d in dtcs if d and d.strip()})
    if not wanted:
        return []
    query_vec = embed_canonical_text(case_query_text(engine_family, wanted))
    family = (engine_family or "").strip().lower()
    with tenant_session(tenant_id, engine) as store:
        store.execute(text("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)"))
        eligible = store.query(ResolvedCase).filter(
            ResolvedCase.embedding.isnot(None),
            ResolvedCase.dtcs.op("&&")(literal(wanted, PG_ARRAY(Text))),
        )
        pool = limit * _POOL_FACTOR
        candidates = (
            eligible.order_by(ResolvedCase.embedding.cosine_distance(query_vec)).limit(pool).all()
        )
        if len(candidates) < pool:
            candidates = eligible.limit(_WIDEN_CANDIDATES).all()

        def rank(row: ResolvedCase) -> tuple:
            shared = len(wanted_set & {str(d).upper() for d in row.dtcs or []})
            same_family = bool(family) and (row.engine_family or "").strip().lower() == family
            similarity = cosine_similarity(list(row.embedding), query_vec)
            created = row.created_at.timestamp() if row.created_at else 0.0
            return (-shared, not same_family, -similarity, -created)

        wanted_set = set(wanted)
        candidates.sort(key=rank)
        return [_case_to_dict(r) for r in candidates[:limit]]


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
    # Raw CAN frames for this session, stored in S3 as a candump log (optional).
    can_frames: list[can_traces.CanFrameIn] = Field(
        default_factory=list, max_length=can_traces.MAX_FRAMES_PER_BATCH
    )
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
                count("obd2_sync_batches_total", outcome="duplicate")
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
                # One row per attempt (A-CEO-4). A record re-sent in a new batch
                # (the edge lost its ack) is skipped, never a conflict: a 409
                # here would block this session's sync for good.
                inserted = store.execute(
                    pg_insert(AuditLogEntry)
                    .values(
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
                    .on_conflict_do_nothing(index_elements=["tenant_id", "edge_session_id", "seq"])
                    .returning(AuditLogEntry.id)
                ).scalar_one_or_none()
                if inserted is not None:
                    audit_ingested += 1

            # Raw frames go to S3 through the outbox, committed with the batch.
            can_traces.queue_trace(
                store, principal.tenant_id, req.batch_id, sess.id, req.can_frames
            )
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

    traces_pending = 0
    if req.can_frames:
        # Committed: upload this batch's trace now. If S3 refuses, the batch has
        # still succeeded and the trace waits in the outbox for the drain.
        with tenant_session(principal.tenant_id) as store:
            traces_pending = can_traces.upload_pending(store, batch_id=req.batch_id)

    inc("sessions_sync_accepted")
    count("obd2_sync_batches_total", outcome="accepted")
    lag = datetime.now(UTC).timestamp() - req.watermark_us / 1_000_000
    if 0 <= lag < 30 * 24 * 3600:  # ignore clocks that are obviously wrong
        observe("obd2_sync_lag_seconds", lag)
    return {
        "status": "accepted",
        "batch_id": req.batch_id,
        "telemetry_ingested": telemetry_ingested,
        "audit_ingested": audit_ingested,
        "can_frames_ingested": len(req.can_frames),
        "traces_pending": traces_pending,
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
