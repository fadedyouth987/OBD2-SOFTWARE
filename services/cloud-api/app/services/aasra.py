"""AASRA / OEM workshop verification.

Client-supplied flags such as ``aasra_verified`` or ``vsp_authorized`` are never
trusted. Verification is gated behind :class:`AasraVerifier`, which fails closed
unless a trusted record already exists on the tenant.

The trusted signal is ``tenants.aasra_verified`` (with ``aasra_verified_until``),
set only when a platform admin approves the workshop's submitted AASRA details
and evidence (``app.services.accreditation``), or, for local development
only, by ``POST /api/v1/auth/dev-mark-aasra`` when ``AUTH_ALLOW_DEV_LOGIN=true``.
AASRA has no public verification API, so review is manual by design; a direct
integration can replace this verifier if one becomes available.
"""

from __future__ import annotations

from typing import Protocol
from uuid import UUID


class AasraVerifier(Protocol):
    def is_verified(self, tenant_id: UUID, *, tenant_flag: bool) -> bool:
        """Return True only when this tenant is known-verified."""


class FailClosedAasraVerifier:
    """Stub verifier that never calls out to AASRA and never trusts the client.

    The database flag is accepted because it is not attacker-controlled: the
    write path is operator/dev-gated, not a public request field.
    """

    def is_verified(self, tenant_id: UUID, *, tenant_flag: bool) -> bool:
        del tenant_id
        return bool(tenant_flag)


def default_verifier() -> AasraVerifier:
    return FailClosedAasraVerifier()
