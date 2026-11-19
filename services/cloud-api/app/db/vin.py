"""VIN handling (Task 2.1).

The full VIN is never stored. ``vehicles.vin_hmac`` is HMAC-SHA256 of the
normalized VIN with a server-side key (``VIN_HMAC_KEY_REF``), so the same car
is recognized within a tenant without keeping the serial. ``wmi_vds`` keeps
positions 1-9 (manufacturer, model and check digit), which the case corpus
uses; positions 10-17 (year, plant, serial) are dropped.
"""

import hashlib
import hmac
import os
import re
from pathlib import Path

_VIN = re.compile(r"^[A-HJ-NPR-Z0-9]{17}$")


def normalize_vin(vin: str) -> str:
    """Uppercased, trimmed VIN. Raises ValueError for anything that is not 17 valid characters."""
    v = vin.strip().upper()
    if not _VIN.fullmatch(v):
        raise ValueError("a VIN is 17 characters, digits and letters except I, O, Q")
    return v


def vin_hmac(vin: str, key: bytes) -> str:
    """Hex HMAC-SHA256 of the normalized VIN."""
    if len(key) < 16:
        raise ValueError("VIN HMAC key must be at least 16 bytes")
    return hmac.new(key, normalize_vin(vin).encode(), hashlib.sha256).hexdigest()


def wmi_vds(vin: str) -> str:
    """VIN positions 1-9."""
    return normalize_vin(vin)[:9]


def resolve_secret(ref: str) -> bytes:
    """Resolves a secret reference: ``env://NAME`` or ``file:///path``.

    ``secretsmanager://`` references are resolved by the deployment (Task 5.x);
    until that exists, using one is a configuration error, not a silent default.
    """
    if ref.startswith("env://"):
        value = os.environ.get(ref.removeprefix("env://"))
        if not value:
            raise RuntimeError(f"secret {ref} is not set")
        return value.encode()
    if ref.startswith("file://"):
        return Path(ref.removeprefix("file://")).read_bytes().strip()
    raise RuntimeError(
        f"secret reference {ref!r} needs the production secret manager (not configured)"
    )
