"""Idempotent session/telemetry/audit sync & resolved case publish (Task 2.2, A-CEO-2, A-CEO-4, A-CEO-6)."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.observability.metrics import inc
from app.services.anonymizer import anonymize_case

router = APIRouter(prefix="/api/v1", tags=["sessions"])

_SEEN_BATCHES: set[str] = set()
_SESSIONS: dict[str, dict[str, Any]] = {}
_PUBLISHED_CASES: list[dict[str, Any]] = []


def _state_file() -> Path:
    base = Path(os.environ.get("CLOUD_STATE_DIR", "/tmp/rootcause_cloud_state"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "sessions_and_cases.json"


def _load_state() -> None:
    p = _state_file()
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            _SEEN_BATCHES.update(data.get("seen_batches", []))
            _SESSIONS.update(data.get("sessions", {}))
            if not _PUBLISHED_CASES:
                _PUBLISHED_CASES.extend(data.get("cases", []))
        except Exception:
            pass
    if not _PUBLISHED_CASES:
        seed_path = Path(__file__).resolve().parents[4] / "packages" / "schemas" / "au_resolved_cases_seed.json"
        if seed_path.exists():
            try:
                _PUBLISHED_CASES.extend(json.loads(seed_path.read_text(encoding="utf-8")))
            except Exception:
                pass


def _save_state() -> None:
    try:
        _state_file().write_text(
            json.dumps(
                {
                    "seen_batches": sorted(_SEEN_BATCHES),
                    "sessions": _SESSIONS,
                    "cases": _PUBLISHED_CASES,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


_load_state()


def list_published_cases(dtcs: list[str] | None = None) -> list[dict[str, Any]]:
    if not dtcs:
        return list(_PUBLISHED_CASES)
    wanted = {d.upper() for d in dtcs}
    return [
        c
        for c in _PUBLISHED_CASES
        if any(str(code).upper() in wanted for code in c.get("dtcs", []))
    ]


class SyncBatchRequest(BaseModel):
    batch_id: str
    tenant_id: str
    session_id: str
    watermark_us: int
    telemetry_rows: list[dict[str, Any]] = []
    audit_entries: list[dict[str, Any]] = []


class PublishCaseRequest(BaseModel):
    vin: str = ""
    wmi_vds: str = ""
    engine_family: str
    dtcs: list[str]
    symptom_summary: str
    verified_fix: str
    parts_replaced: list[str] = []


@router.post("/sessions/sync")
def sync_session_batch(req: SyncBatchRequest) -> dict[str, Any]:
    if req.batch_id in _SEEN_BATCHES:
        inc("sessions_sync_deduped")
        return {"status": "duplicate_ignored", "batch_id": req.batch_id, "watermark_us": req.watermark_us}
    _SEEN_BATCHES.add(req.batch_id)
    sess = _SESSIONS.setdefault(
        req.session_id,
        {
            "session_id": req.session_id,
            "tenant_id": req.tenant_id,
            "watermark_us": 0,
            "telemetry_rows": [],
            "audit_entries": [],
        },
    )
    sess["watermark_us"] = max(int(sess["watermark_us"]), req.watermark_us)
    sess["telemetry_rows"].extend(req.telemetry_rows)
    sess["audit_entries"].extend(req.audit_entries)
    _save_state()
    inc("sessions_sync_accepted")
    return {
        "status": "accepted",
        "batch_id": req.batch_id,
        "telemetry_ingested": len(req.telemetry_rows),
        "audit_ingested": len(req.audit_entries),
        "watermark_us": req.watermark_us,
    }


@router.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict[str, Any]:
    sess = _SESSIONS.get(session_id)
    if not sess:
        raise HTTPException(status_code=404, detail=f"Session {session_id} not found")
    return sess


@router.post("/cases/publish")
def publish_resolved_case(req: PublishCaseRequest) -> dict[str, Any]:
    scrubbed = anonymize_case((req.model_dump() if hasattr(req, 'model_dump') else req.dict()))
    case_id = f"CASE-AU-2026-{len(_PUBLISHED_CASES) + 1:04d}"
    record = {"case_id": case_id, **scrubbed}
    _PUBLISHED_CASES.append(record)
    _save_state()
    inc("cases_published")
    return {"status": "published", "case": record, "total_resolved_cases": len(_PUBLISHED_CASES)}


@router.get("/cases")
def get_cases(dtc: str | None = Query(default=None)) -> dict[str, Any]:
    items = list_published_cases([dtc] if dtc else None)
    return {"total": len(items), "cases": items}
