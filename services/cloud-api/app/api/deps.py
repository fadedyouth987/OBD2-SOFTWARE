"""Authenticated principal for cloud-api routes.

Tenant, user, subscription tier, and AASRA status are always loaded from the
database for the identity in the session JWT. Request bodies cannot set them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.db.models import SubscriptionTier, Tenant, TenantMembership
from app.db.session import tenant_session
from app.services.signing import SigningKeyError, verify_session_jwt

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    tenant_id: UUID
    user_id: UUID
    tier: SubscriptionTier
    aasra_verified: bool
    tenant_name: str


def get_principal(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Principal:
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        claims = verify_session_jwt(creds.credentials)
        tenant_id = UUID(str(claims["tenant_id"]))
        user_id = UUID(str(claims["user_id"]))
    except (SigningKeyError, ValueError, KeyError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired session",
        ) from exc
    try:
        with tenant_session(tenant_id) as session:
            tenant = session.get(Tenant, tenant_id)
            if tenant is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown tenant"
                )
            membership = session.get(TenantMembership, (tenant_id, user_id))
            if membership is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Not a member of this tenant",
                )
            return Principal(
                tenant_id=tenant.id,
                user_id=user_id,
                tier=tenant.subscription_tier,
                aasra_verified=bool(tenant.aasra_verified),
                tenant_name=tenant.name,
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Identity store unavailable",
        ) from exc


RequirePrincipal = Annotated[Principal, Depends(get_principal)]
