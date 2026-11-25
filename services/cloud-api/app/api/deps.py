"""Authenticated principal for cloud-api routes.

Tenant, user, subscription tier, role, and AASRA status are always loaded
from the database for the identity in the session JWT. Request bodies cannot
set them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.db.models import MembershipRole, SubscriptionTier, Tenant, TenantMembership
from app.db.session import tenant_session
from app.services.billing import effective_tier, maybe_expire_grace
from app.services.signing import SigningKeyError, verify_session_jwt

_bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class Principal:
    tenant_id: UUID
    user_id: UUID
    tier: SubscriptionTier
    aasra_verified: bool
    tenant_name: str
    role: MembershipRole = MembershipRole.TECH
    immo_entitled: bool = False
    lease_version: int = 0
    billing_status: str = "none"


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
            maybe_expire_grace(session, tenant)
            membership = session.get(TenantMembership, (tenant_id, user_id))
            if membership is None:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Not a member of this tenant",
                )
            tier = effective_tier(
                tenant.subscription_tier,
                billing_status=tenant.stripe_subscription_status,
                billing_grace_until=tenant.billing_grace_until,
            )
            immo = bool(tenant.immo_entitled) and tier in {
                SubscriptionTier.WORKSHOP,
                SubscriptionTier.FLEET,
            }
            return Principal(
                tenant_id=tenant.id,
                user_id=user_id,
                tier=tier,
                # An approval with an expiry stops counting the moment it lapses.
                aasra_verified=bool(tenant.aasra_verified)
                and (
                    tenant.aasra_verified_until is None
                    or tenant.aasra_verified_until > datetime.now(UTC)
                ),
                tenant_name=tenant.name,
                role=membership.role,
                immo_entitled=immo,
                lease_version=int(tenant.lease_version or 0),
                billing_status=tenant.stripe_subscription_status or "none",
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Identity store unavailable",
        ) from exc


RequirePrincipal = Annotated[Principal, Depends(get_principal)]
