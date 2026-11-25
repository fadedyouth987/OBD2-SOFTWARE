"""Platform admin: accreditation review (and licensed procedure imports).

Platform admins are operators of this RootCause deployment, not workshop
roles. The flag is granted only from the command line
(``python -m app.cli grant-platform-admin <email>``).
"""

from __future__ import annotations

from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.api.deps import Principal, RequirePrincipal
from app.api.v1.accreditation import stream
from app.services import accreditation

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def require_platform_admin(principal: RequirePrincipal) -> Principal:
    if not accreditation.is_platform_admin(principal.user_id):
        raise HTTPException(status_code=403, detail="This is for platform admins only")
    return principal


RequireAdmin = Annotated[Principal, Depends(require_platform_admin)]
Status = Literal["PENDING", "APPROVED", "REJECTED", "EXPIRED", "REVOKED", "SUPERSEDED", "ALL"]


@router.get("/accreditations")
def queue(admin: RequireAdmin, status: Annotated[Status, Query()] = "PENDING") -> dict:
    return {"items": accreditation.admin_queue(status)}


@router.get("/accreditations/{request_id}/evidence/{evidence_id}")
def evidence(request_id: UUID, evidence_id: UUID, admin: RequireAdmin) -> Response:
    return stream(*accreditation.admin_evidence(request_id, evidence_id))


class ApproveRequest(BaseModel):
    expires_on: date | None = None


class ReasonRequest(BaseModel):
    reason: str = Field(max_length=1000)


@router.post("/accreditations/{request_id}/approve")
def approve(request_id: UUID, req: ApproveRequest, admin: RequireAdmin) -> dict:
    return accreditation.approve(admin.user_id, request_id, req.expires_on)


@router.post("/accreditations/{request_id}/reject")
def reject(request_id: UUID, req: ReasonRequest, admin: RequireAdmin) -> dict:
    return accreditation.reject(admin.user_id, request_id, req.reason)


@router.post("/accreditations/{request_id}/revoke")
def revoke(request_id: UUID, req: ReasonRequest, admin: RequireAdmin) -> dict:
    return accreditation.revoke(admin.user_id, request_id, req.reason)


@router.post("/accreditations/run-reminders")
def run_reminders(admin: RequireAdmin) -> dict:
    return accreditation.run_reminders()
