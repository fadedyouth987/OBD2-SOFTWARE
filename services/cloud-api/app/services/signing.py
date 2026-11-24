"""Ed25519 offline edge-lease and origin-bound pairing JWT signer (Task 2.2).

Matches exact claim validation in `apps/edge-daemon/src/auth/lease.rs`:
- Lease (`aud="edge-daemon"`): `tenant_id`, `tier`, `features`, `aasra_verified`, `nbf`, `exp`
- Pairing (`aud="edge-ws"`): `user_id`, `tenant_id`, `origin`, `nbf`, `exp`
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from typing import Any

PINNED_KID = "cloud-2026-11"
DEFAULT_LEASE_TTL_S = 72 * 3600  # 72-hour offline edge lease (MAX_LEASE_SECS)
DEFAULT_PAIRING_TTL_S = 120      # 2-minute browser pairing token (<= 300s MAX_PAIRING_SECS)
_DEV_SEED = hashlib.sha256(b"rootcause-dev-ed25519-seed-2026").digest()

TIER_DEFAULT_FEATURES: dict[str, list[str]] = {
    "COMMUNITY": [],
    "PRO": ["UDS_ACTIVE"],
    "WORKSHOP": ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"],
    "FLEET": ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"],
}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _load_ed25519_private_key():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key_hex = os.environ.get("CLOUD_SIGNING_PRIVATE_KEY_HEX", "").strip()
    seed = bytes.fromhex(key_hex) if key_hex else _DEV_SEED
    return Ed25519PrivateKey.from_private_bytes(seed[:32])


def get_public_jwk() -> dict[str, Any]:
    """Returns the active Ed25519 public key in JWK format for verification."""
    try:
        from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

        priv = _load_ed25519_private_key()
        pub_raw = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return {
            "kty": "OKP",
            "crv": "Ed25519",
            "kid": PINNED_KID,
            "use": "sig",
            "alg": "EdDSA",
            "x": _b64url(pub_raw),
            "raw_hex": pub_raw.hex(),
        }
    except Exception:
        return {"kty": "oct", "kid": PINNED_KID, "alg": "HS256-dev"}


def _sign_payload(header: dict[str, Any], payload: dict[str, Any]) -> str:
    """Signs JWS compact serialization using Ed25519 (deterministic dev seed if key unset)."""
    signing_input = (
        f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}."
        f"{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    )
    key_hex = os.environ.get("CLOUD_SIGNING_PRIVATE_KEY_HEX", "").strip()
    try:
        priv = _load_ed25519_private_key()
        sig = priv.sign(signing_input.encode("ascii"))
    except Exception:
        secret = (key_hex or "dev-only-ed25519-fallback").encode("utf-8")
        sig = hmac.new(secret, signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(sig)}"


def issue_edge_lease(
    tenant_id: str,
    user_id: str,
    tier: str = "WORKSHOP",
    features: list[str] | None = None,
    dongle_id: str | None = None,
    aasra_verified: bool = False,
    ttl_s: int = DEFAULT_LEASE_TTL_S,
) -> dict[str, Any]:
    now = int(time.time())
    norm_tier = tier.upper()
    edge_tier = "WORKSHOP" if norm_tier == "FLEET" else norm_tier
    if edge_tier not in {"COMMUNITY", "PRO", "WORKSHOP"}:
        edge_tier = "COMMUNITY"
    granted = features if features is not None else TIER_DEFAULT_FEATURES.get(norm_tier, [])
    effective_ttl = min(ttl_s, DEFAULT_LEASE_TTL_S)
    payload: dict[str, Any] = {
        "iss": "obd2-cloud-api",
        "aud": "edge-daemon",
        "sub": user_id,
        "user_id": user_id,
        "tenant_id": tenant_id,
        "tier": edge_tier,
        "plan_tier": norm_tier,
        "features": granted,
        "aasra_verified": aasra_verified,
        "nbf": now,
        "iat": now,
        "exp": now + effective_ttl,
    }
    if dongle_id:
        payload["rcid"] = dongle_id
    token = _sign_payload({"alg": "EdDSA", "typ": "JWT", "kid": PINNED_KID}, payload)
    return {
        "token": token,
        "kid": PINNED_KID,
        "expires_at": payload["exp"],
        "tier": edge_tier,
        "plan_tier": norm_tier,
        "features": granted,
    }


def issue_pairing_jwt(tenant_id: str, user_id: str, origin: str) -> dict[str, Any]:
    now = int(time.time())
    payload = {
        "iss": "obd2-cloud-api",
        "aud": "edge-ws",
        "sub": user_id,
        "user_id": user_id,
        "tenant_id": tenant_id,
        "origin": origin,
        "purpose": "edge-pairing",
        "nbf": now,
        "iat": now,
        "exp": now + DEFAULT_PAIRING_TTL_S,
    }
    token = _sign_payload({"alg": "EdDSA", "typ": "JWT", "kid": PINNED_KID}, payload)
    return {"token": token, "kid": PINNED_KID, "expires_at": payload["exp"], "origin": origin}
