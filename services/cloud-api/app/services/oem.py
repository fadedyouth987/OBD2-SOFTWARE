"""OEM broker adapters for immobilizer credentials.

Technicians hold their own AASRA/OEM accounts. This service never stores
PIN, immobiliser, or key codes. Production has no real OEM integration yet:
the default adapter fails closed. A sandbox adapter issues a well-known
test token only when AUTH_ALLOW_DEV_LOGIN is enabled.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol

from app.services.immo_catalog import SANDBOX_KEY_HEX, SANDBOX_OEM, SANDBOX_OPERATION


class OemUnavailable(RuntimeError):
    """Raised when an OEM token cannot be issued (fail closed)."""


@dataclass(frozen=True)
class OemToken:
    """A just-in-time SecurityAccess payload. Do not persist."""

    oem: str
    operation: str
    payload_hex: str
    description: str


class OemAdapter(Protocol):
    def issue_token(self, *, oem: str, operation: str) -> OemToken: ...


def _dev_login_enabled() -> bool:
    return os.environ.get("AUTH_ALLOW_DEV_LOGIN", "").strip().lower() in {"1", "true", "yes"}


class FailClosedOemAdapter:
    """Production default: never issues credentials."""

    def issue_token(self, *, oem: str, operation: str) -> OemToken:
        raise OemUnavailable("OEM key broker is not configured; immobilizer tokens are unavailable")


class SandboxOemAdapter:
    """Issues the well-known sandbox key only under AUTH_ALLOW_DEV_LOGIN."""

    def issue_token(self, *, oem: str, operation: str) -> OemToken:
        if not _dev_login_enabled():
            raise OemUnavailable("sandbox OEM tokens require AUTH_ALLOW_DEV_LOGIN")
        if oem != SANDBOX_OEM or operation != SANDBOX_OPERATION:
            raise OemUnavailable(f"sandbox adapter does not support {oem}/{operation}")
        return OemToken(
            oem=oem,
            operation=operation,
            payload_hex=SANDBOX_KEY_HEX,
            description="sandbox on-board add-key token (not an OEM algorithm)",
        )


def default_adapter() -> OemAdapter:
    if _dev_login_enabled():
        return SandboxOemAdapter()
    return FailClosedOemAdapter()
