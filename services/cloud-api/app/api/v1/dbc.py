"""Custom tenant DBC file registry endpoints (Task 2.2)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/dbc", tags=["dbc"])
_DBC_STORE: dict[str, list[dict[str, str]]] = {}


class DbcUploadRequest(BaseModel):
    tenant_id: str
    name: str
    vehicle_profile: str
    content_preview: str


@router.post("")
def upload_dbc(req: DbcUploadRequest) -> dict:
    items = _DBC_STORE.setdefault(req.tenant_id, [])
    entry = {"name": req.name, "vehicle_profile": req.vehicle_profile}
    items.append(entry)
    return {"status": "stored", "dbc": entry}


@router.get("/{tenant_id}")
def list_dbc(tenant_id: str) -> dict:
    return {"tenant_id": tenant_id, "items": _DBC_STORE.get(tenant_id, [])}
