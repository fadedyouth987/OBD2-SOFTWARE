"""Wiring schematic uploads: PDF or image, stored privately per workshop.

Pages count against the plan's monthly schematic allowance when they're
uploaded (a PDF's page count; an image is one page). The file is checked by
its content, not its name, and stored before the pages are charged; if the
allowance is used up the stored file is deleted again, so nothing is charged
for a refused upload.
"""

from __future__ import annotations

import hashlib
import io
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile, status

from app.api.deps import RequirePrincipal
from app.db.models import WiringSchematic
from app.db.session import tenant_session
from app.observability.metrics import inc
from app.services import object_store
from app.services.billing import charge_schematic_pages, quotas_for

router = APIRouter(prefix="/api/v1/schematics", tags=["schematics"])

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 300

_TYPES = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
}


def sniff_type(data: bytes) -> str | None:
    """Content type from the file's own bytes."""
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return None


def count_pages(data: bytes, content_type: str) -> int:
    if content_type != "application/pdf":
        return 1
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise HTTPException(
                status_code=422, detail="That PDF is password-protected. Upload an unlocked copy."
            )
        pages = len(reader.pages)
    except HTTPException:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail="That PDF couldn't be read.") from exc
    if pages < 1:
        raise HTTPException(status_code=422, detail="That PDF has no pages.")
    return pages


def _row_json(r: WiringSchematic) -> dict:
    return {
        "id": str(r.id),
        "title": r.title,
        "vehicle_profile": r.vehicle_profile,
        "content_type": r.content_type,
        "size_bytes": r.size_bytes,
        "page_count": r.page_count,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


@router.get("")
def list_schematics(principal: RequirePrincipal, vehicle_profile: str | None = None) -> dict:
    q = quotas_for(principal.tier)
    with tenant_session(principal.tenant_id) as session:
        query = session.query(WiringSchematic)
        if vehicle_profile:
            query = query.filter(WiringSchematic.vehicle_profile == vehicle_profile)
        rows = query.order_by(WiringSchematic.created_at.desc()).limit(200).all()
        return {"items": [_row_json(r) for r in rows], "pages_limit": q.schematic_pages}


@router.post("", status_code=201)
async def upload_schematic(
    principal: RequirePrincipal,
    file: Annotated[UploadFile, File()],
    title: Annotated[str, Form(max_length=200)] = "",
    vehicle_profile: Annotated[str, Form(max_length=80)] = "",
) -> dict:
    q = quotas_for(principal.tier)
    if q.schematic_pages <= 0:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Schematic uploads are included from the Pro plan.",
        )
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="That file is over 25 MB.")
    if not data:
        raise HTTPException(status_code=422, detail="That file is empty.")
    content_type = sniff_type(data)
    if content_type is None:
        raise HTTPException(status_code=415, detail="Upload a PDF, PNG or JPEG.")
    pages = count_pages(data, content_type)
    if pages > MAX_PAGES:
        raise HTTPException(
            status_code=422,
            detail=f"That PDF has {pages} pages; split it into {MAX_PAGES} or fewer.",
        )
    schematic_id = uuid4()
    key = object_store.object_key(
        "schematics", principal.tenant_id, schematic_id, _TYPES[content_type]
    )
    try:
        object_store.put(key, data, content_type)
    except object_store.StorageError as exc:
        raise HTTPException(
            status_code=503, detail="File storage is unavailable. Try again shortly."
        ) from exc
    ok, used, limit = charge_schematic_pages(principal.tenant_id, pages)
    if not ok:
        try:
            object_store.delete(key)
        except object_store.StorageError:
            pass  # An orphaned private object, unreachable without a row; logged by S3.
        left = max(0, limit - used)
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(
                f"This file has {pages} page{'s' if pages != 1 else ''} and you have {left} of "
                f"{limit} schematic pages left this month."
            ),
        )
    name = " ".join((title or file.filename or "Schematic").split())[:200] or "Schematic"
    with tenant_session(principal.tenant_id) as session:
        row = WiringSchematic(
            id=schematic_id,
            tenant_id=principal.tenant_id,
            title=name,
            s3_key=key,
            page_count=pages,
            status="UPLOADED",
            vehicle_profile=vehicle_profile.strip() or None,
            content_type=content_type,
            size_bytes=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
            uploaded_by=principal.user_id,
        )
        session.add(row)
        session.flush()
        session.refresh(row)
        out = _row_json(row)
    inc("schematic_uploaded")
    return {"schematic": out, "pages_used": used, "pages_limit": limit}


def _owned(session, principal, schematic_id: UUID) -> WiringSchematic:
    row = session.get(WiringSchematic, schematic_id)
    if row is None or not object_store.key_belongs_to(row.s3_key, principal.tenant_id):
        raise HTTPException(status_code=404, detail="No schematic with that id")
    return row


@router.get("/{schematic_id}/file")
def download_schematic(schematic_id: UUID, principal: RequirePrincipal) -> Response:
    with tenant_session(principal.tenant_id) as session:
        row = _owned(session, principal, schematic_id)
        key, ctype, title = row.s3_key, row.content_type or "application/octet-stream", row.title
    try:
        data = object_store.get(key)
    except object_store.StorageError as exc:
        raise HTTPException(status_code=503, detail="File storage is unavailable.") from exc
    safe = "".join(c if c.isalnum() or c in " ._-" else "_" for c in title)[:100] or "schematic"
    return Response(
        content=data,
        media_type=ctype,
        headers={
            "Content-Disposition": f'inline; filename="{safe}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.delete("/{schematic_id}", status_code=204)
def delete_schematic(schematic_id: UUID, principal: RequirePrincipal) -> None:
    with tenant_session(principal.tenant_id) as session:
        row = _owned(session, principal, schematic_id)
        key = row.s3_key
        session.delete(row)
    try:
        object_store.delete(key)
    except object_store.StorageError:
        pass  # The row is gone, so the object is unreachable; storage lifecycle can sweep it.
