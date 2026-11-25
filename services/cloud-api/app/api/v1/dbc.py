"""Custom DBC files for CAN Studio, stored privately per workshop (Task 2.2).

A DBC is plain text. The API checks it looks like a DBC (at least one BO_
message definition), keeps the file in object storage and the metadata in
Postgres. Workshop and Fleet plans only (CAN Studio).
"""

from __future__ import annotations

import hashlib
import re
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status

from app.api.deps import Principal, RequirePrincipal
from app.db.models import CustomDbcFile
from app.db.session import tenant_session
from app.services import object_store
from app.services.billing import quotas_for
from app.services.permissions import Permission, require_own_or

router = APIRouter(prefix="/api/v1/dbc", tags=["dbc"])

MAX_BYTES = 2 * 1024 * 1024
MAX_FILES = 100
_MESSAGE = re.compile(r"^\s*BO_\s+\d+\s+\w+\s*:", re.MULTILINE)


def message_count(text: str) -> int:
    return len(_MESSAGE.findall(text))


def _require_can_studio(principal: Principal) -> None:
    if "CAN_RE_PRO" not in quotas_for(principal.tier).features:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Saving DBC files is part of CAN Studio, on the Workshop and Fleet plans.",
        )


def _row_json(r: CustomDbcFile) -> dict:
    return {
        "id": str(r.id),
        "name": r.name,
        "vehicle_profile": r.vehicle_profile,
        "size_bytes": r.size_bytes,
        "message_count": r.message_count,
        "sha256": r.sha256,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "created_by": str(r.created_by) if r.created_by else None,
    }


@router.get("")
def list_dbc(principal: RequirePrincipal) -> dict:
    with tenant_session(principal.tenant_id) as session:
        rows = session.query(CustomDbcFile).order_by(CustomDbcFile.created_at.desc()).all()
        return {"items": [_row_json(r) for r in rows if r.size_bytes is not None]}


@router.post("", status_code=201)
async def upload_dbc(
    principal: RequirePrincipal,
    file: Annotated[UploadFile, File()],
    vehicle_profile: Annotated[str, Form(max_length=80)] = "",
) -> dict:
    _require_can_studio(principal)
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="That DBC is over 2 MB.")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("latin-1")  # Vendor DBCs are often CP1252/Latin-1.
    count = message_count(text)
    if count == 0:
        raise HTTPException(
            status_code=422, detail="That doesn't look like a DBC file (no BO_ messages found)."
        )
    name = " ".join((file.filename or "custom.dbc").split())[:120]
    digest = hashlib.sha256(data).hexdigest()
    dbc_id = uuid4()
    key = object_store.object_key("dbc", principal.tenant_id, dbc_id, "dbc")
    with tenant_session(principal.tenant_id) as session:
        existing = session.query(CustomDbcFile).filter(CustomDbcFile.sha256 == digest).first()
        if existing is not None and existing.size_bytes is not None:
            raise HTTPException(
                status_code=409, detail=f"That file is already saved as {existing.name}."
            )
        if session.query(CustomDbcFile).count() >= MAX_FILES:
            raise HTTPException(
                status_code=409, detail=f"You can keep up to {MAX_FILES} DBC files."
            )
    try:
        object_store.put(key, data, "text/plain; charset=utf-8")
    except object_store.StorageError as exc:
        raise HTTPException(
            status_code=503, detail="File storage is unavailable. Try again shortly."
        ) from exc
    with tenant_session(principal.tenant_id) as session:
        row = CustomDbcFile(
            id=dbc_id,
            tenant_id=principal.tenant_id,
            name=name,
            s3_key=key,
            sha256=digest,
            created_by=principal.user_id,
            vehicle_profile=vehicle_profile.strip() or None,
            size_bytes=len(data),
            message_count=count,
        )
        session.add(row)
        session.flush()
        session.refresh(row)
        return {"dbc": _row_json(row)}


def _owned(session, principal: Principal, dbc_id: UUID) -> CustomDbcFile:
    row = session.get(CustomDbcFile, dbc_id)
    if row is None or not object_store.key_belongs_to(row.s3_key, principal.tenant_id):
        raise HTTPException(status_code=404, detail="No DBC file with that id")
    return row


@router.get("/{dbc_id}/file")
def download_dbc(dbc_id: UUID, principal: RequirePrincipal) -> Response:
    with tenant_session(principal.tenant_id) as session:
        key = _owned(session, principal, dbc_id).s3_key
    try:
        data = object_store.get(key)
    except object_store.StorageError as exc:
        raise HTTPException(status_code=503, detail="File storage is unavailable.") from exc
    return Response(
        content=data,
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.delete("/{dbc_id}", status_code=204)
def delete_dbc(dbc_id: UUID, principal: RequirePrincipal) -> None:
    with tenant_session(principal.tenant_id) as session:
        row = _owned(session, principal, dbc_id)
        require_own_or(principal, row.created_by, Permission.MANAGE_SHARED_FILES)
        key = row.s3_key
        session.delete(row)
    try:
        object_store.delete(key)
    except object_store.StorageError:
        pass
