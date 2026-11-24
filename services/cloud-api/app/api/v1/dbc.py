"""Custom tenant DBC file registry endpoints (Task 2.2)."""

from __future__ import annotations

import hashlib
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.api.deps import RequirePrincipal
from app.db.models import CustomDbcFile
from app.db.session import tenant_session

router = APIRouter(prefix="/api/v1/dbc", tags=["dbc"])


class DbcUploadRequest(BaseModel):
    name: str
    vehicle_profile: str
    content_preview: str = ""
    # Ignored: tenant comes from the session.
    tenant_id: str | None = None


@router.post("")
def upload_dbc(req: DbcUploadRequest, principal: RequirePrincipal) -> dict:
    digest = hashlib.sha256(req.content_preview.encode("utf-8")).hexdigest()
    s3_key = f"dbc/{principal.tenant_id}/{req.name}"
    with tenant_session(principal.tenant_id) as session:
        row = CustomDbcFile(
            id=uuid4(),
            tenant_id=principal.tenant_id,
            name=req.name,
            s3_key=s3_key,
            sha256=digest,
            created_by=principal.user_id,
        )
        session.add(row)
        entry = {
            "id": str(row.id),
            "name": row.name,
            "vehicle_profile": req.vehicle_profile,
            "sha256": digest,
        }
    return {"status": "stored", "dbc": entry}


@router.get("/{tenant_id}")
def list_dbc(tenant_id: str, principal: RequirePrincipal) -> dict:
    try:
        requested = UUID(tenant_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Unknown tenant") from exc
    if requested != principal.tenant_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    with tenant_session(principal.tenant_id) as session:
        items = [
            {"id": str(row.id), "name": row.name, "sha256": row.sha256}
            for row in session.query(CustomDbcFile).all()
        ]
    return {"tenant_id": str(principal.tenant_id), "items": items}
