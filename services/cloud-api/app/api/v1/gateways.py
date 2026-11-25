"""Australian MVIS / AASRA & SGW secure diagnostic gateway compliance hooks (Task 2.3)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.api.deps import RequirePrincipal
from app.observability.metrics import inc
from app.services.aasra import default_verifier
from app.services.signing import SigningKeyError, issue_edge_lease

router = APIRouter(prefix="/api/v1/gateways", tags=["gateways"])


class AasraCheckRequest(BaseModel):
    workshop_abn: str = ""
    aasra_member_id: str = ""
    oem: str = ""
    # Ignored: never trusted from the client.
    vsp_authorized: bool = False
    tenant_id: str | None = None
    user_id: str | None = None


class SgwUnlockRequest(BaseModel):
    oem: str
    vin: str = Field(default="", max_length=32)
    aasra_member_id: str = ""
    autoauth_account: str = ""
    tenant_id: str | None = None
    user_id: str | None = None


@router.post("/aasra/verify")
def verify_aasra_entitlement(req: AasraCheckRequest, principal: RequirePrincipal) -> dict:
    verified = default_verifier().is_verified(
        principal.tenant_id, tenant_flag=principal.aasra_verified
    )
    well_formed = len(req.workshop_abn.replace(" ", "")) == 11 and bool(req.aasra_member_id.strip())
    # Eligibility requires the trusted verifier, not the client flag or ABN format alone.
    eligible = bool(verified)
    resp: dict = {
        "eligible": eligible,
        "scheme": "AU-MVIS-AASRA",
        "oem": req.oem,
        "region": "ap-southeast-2",
        "request_well_formed": well_formed,
    }
    if eligible:
        inc("gateway_aasra_verified")
    return resp


@router.post("/sgw/unlock")
def unlock_sgw_gateway(req: SgwUnlockRequest, principal: RequirePrincipal) -> dict:
    verified = default_verifier().is_verified(
        principal.tenant_id, tenant_flag=principal.aasra_verified
    )
    if not verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="SGW unlock requires a verified AASRA workshop on this tenant",
        )
    inc("gateway_sgw_unlocked")
    try:
        lease = issue_edge_lease(
            tenant_id=str(principal.tenant_id),
            user_id=str(principal.user_id),
            tier=principal.tier.value,
            ttl_s=900,
            aasra_verified=True,
        )
    except SigningKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    # Do not echo the VIN (or even the last four) back to the client.
    return {
        "status": "unlocked",
        "oem": req.oem,
        "sgw_session_lease": lease,
    }
