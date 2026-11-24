"""Australian MVIS / AASRA & SGW secure diagnostic gateway compliance hooks (Task 2.3)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.observability.metrics import inc
from app.services.signing import issue_edge_lease

router = APIRouter(prefix="/api/v1/gateways", tags=["gateways"])


class AasraCheckRequest(BaseModel):
    workshop_abn: str
    aasra_member_id: str
    oem: str
    vsp_authorized: bool = False
    tenant_id: str = "t_au_workshop"
    user_id: str = "u_tech"


class SgwUnlockRequest(BaseModel):
    tenant_id: str
    user_id: str
    vin: str
    oem: str
    aasra_member_id: str = ""
    autoauth_account: str = ""


@router.post("/aasra/verify")
def verify_aasra_entitlement(req: AasraCheckRequest) -> dict:
    valid = len(req.workshop_abn.replace(" ", "")) == 11 and bool(req.aasra_member_id.strip())
    resp: dict = {
        "eligible": valid,
        "scheme": "AU-MVIS-AASRA",
        "oem": req.oem,
        "region": "ap-southeast-2",
    }
    if valid and req.vsp_authorized:
        inc("gateway_immo_lease_issued")
        resp["immo_lease"] = issue_edge_lease(
            tenant_id=req.tenant_id,
            user_id=req.user_id,
            tier="WORKSHOP",
            features=["UDS_ACTIVE", "CAN_STUDIO", "AI_COPILOT", "IMMO_AUTH"],
        )
    return resp


@router.post("/sgw/unlock")
def unlock_sgw_gateway(req: SgwUnlockRequest) -> dict:
    if not (req.aasra_member_id.strip() or req.autoauth_account.strip()):
        raise HTTPException(
            status_code=403,
            detail="SGW unlock requires a verified AASRA or AutoAuth credential",
        )
    inc("gateway_sgw_unlocked")
    lease = issue_edge_lease(
        tenant_id=req.tenant_id,
        user_id=req.user_id,
        tier="WORKSHOP",
        features=["UDS_ACTIVE", "SGW_UNLOCK"],
        ttl_s=900,  # 15-minute SGW diagnostic session
    )
    return {
        "status": "unlocked",
        "oem": req.oem,
        "vin_last4": req.vin[-4:] if len(req.vin) >= 4 else req.vin,
        "sgw_session_lease": lease,
    }
