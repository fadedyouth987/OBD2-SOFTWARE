"""Edge lease & pairing JWT endpoints (Task 2.2)."""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.v1.billing import get_tenant_tier
from app.observability.metrics import inc
from app.services.signing import get_public_jwk, issue_edge_lease, issue_pairing_jwt

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class LeaseRequest(BaseModel):
    tenant_id: str
    user_id: str
    tier: str | None = None
    dongle_id: str | None = None
    aasra_verified: bool = False


class PairingRequest(BaseModel):
    tenant_id: str
    user_id: str
    origin: str


@router.get("/jwks")
def list_jwks() -> dict:
    return {"keys": [get_public_jwk()]}


@router.post("/edge-lease")
def create_edge_lease(req: LeaseRequest) -> dict:
    inc("auth_edge_lease_issued")
    active_tier = get_tenant_tier(req.tenant_id, default=req.tier or "WORKSHOP")
    return issue_edge_lease(
        req.tenant_id,
        req.user_id,
        tier=active_tier,
        dongle_id=req.dongle_id,
        aasra_verified=req.aasra_verified,
    )


@router.post("/edge-pairing")
def create_edge_pairing(req: PairingRequest) -> dict:
    inc("auth_edge_pairing_issued")
    return issue_pairing_jwt(req.tenant_id, req.user_id, origin=req.origin)
