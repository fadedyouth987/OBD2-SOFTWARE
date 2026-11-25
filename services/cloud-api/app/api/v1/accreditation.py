"""AASRA accreditation: what a technician or workshop Owner submits and sees."""

from __future__ import annotations

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, Response, UploadFile

from app.api.deps import RequirePrincipal
from app.services import accreditation, object_store
from app.services.permissions import Permission, require

router = APIRouter(prefix="/api/v1/accreditation", tags=["accreditation"])


async def _read(files: list[UploadFile] | None) -> list[accreditation.EvidenceFile]:
    out = []
    for f in files or []:
        if not f.filename and not f.size:
            continue  # An empty file input sends a blank part.
        data = await f.read(accreditation.EVIDENCE_MAX_BYTES + 1)
        out.append(accreditation.EvidenceFile(filename=f.filename or "evidence", data=data))
    return out


@router.get("")
def my_status(principal: RequirePrincipal) -> dict:
    return accreditation.subject_status(principal)


@router.post("/technician", status_code=201)
async def submit_technician(
    principal: RequirePrincipal,
    aasra_member_id: Annotated[str, Form(max_length=64)],
    declared: Annotated[bool, Form()] = False,
    national_police_check_dated: Annotated[date | None, Form()] = None,
    repairer_licence_renewed_at: Annotated[date | None, Form()] = None,
    evidence: Annotated[list[UploadFile] | None, File()] = None,
) -> dict:
    files = await _read(evidence)
    return accreditation.submit(
        principal,
        accreditation.TECHNICIAN,
        aasra_member_id=aasra_member_id,
        declared=declared,
        files=files,
        national_police_check_dated=national_police_check_dated,
        repairer_licence_renewed_at=repairer_licence_renewed_at,
    )


@router.post("/workshop", status_code=201)
async def submit_workshop(
    principal: RequirePrincipal,
    aasra_member_id: Annotated[str, Form(max_length=64)],
    business_abn: Annotated[str, Form(max_length=20)],
    declared: Annotated[bool, Form()] = False,
    evidence: Annotated[list[UploadFile] | None, File()] = None,
) -> dict:
    require(principal, Permission.SUBMIT_WORKSHOP_ACCREDITATION)
    files = await _read(evidence)
    return accreditation.submit(
        principal,
        accreditation.WORKSHOP,
        aasra_member_id=aasra_member_id,
        declared=declared,
        files=files,
        business_abn=business_abn,
    )


def stream(key: str, ctype: str, filename: str) -> Response:
    try:
        data = object_store.get(key)
    except object_store.StorageError as exc:
        raise HTTPException(status_code=503, detail="File storage is unavailable.") from exc
    return Response(
        content=data,
        media_type=ctype,
        headers={
            "Content-Disposition": f'inline; filename="{filename}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/evidence/{evidence_id}")
def my_evidence(evidence_id: UUID, principal: RequirePrincipal) -> Response:
    return stream(*accreditation.member_evidence(principal, evidence_id))
