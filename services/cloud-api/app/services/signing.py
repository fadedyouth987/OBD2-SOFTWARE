"""Ed25519 offline edge-lease, pairing, and cloud-api session JWT signer (Task 2.2).

Matches claim validation in `apps/edge-daemon/src/auth/lease.rs`:
- Lease (`aud="edge-daemon"`): `tenant_id`, `tier`, `features`, `aasra_verified`, `nbf`, `exp`
- Pairing (`aud="edge-ws"`): `user_id`, `tenant_id`, `origin`, `nbf`, `exp`

Session tokens (`aud="cloud-api"`) identify a user and tenant only. Tier,
AASRA status, and entitlements are loaded from the database on each request.

The signing key is read from `CLOUD_SIGNING_PRIVATE_KEY_HEX` (32-byte seed as
64 hex chars). There is no baked-in development seed and no HMAC fallback:
if the key is missing or invalid, signing and verification fail closed.
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any

PINNED_KID = "cloud-2026-11"
DEFAULT_LEASE_TTL_S = 72 * 3600  # 72-hour offline edge lease (MAX_LEASE_SECS)
DEFAULT_PAIRING_TTL_S = 120  # 2-minute browser pairing token (<= 300s MAX_PAIRING_SECS)
DEFAULT_SESSION_TTL_S = 12 * 3600

# Features the edge Feature enum actually understands. Anything else is dropped.
KNOWN_FEATURES: frozenset[str] = frozenset({"J2534", "UDS_ACTIVE", "CAN_RE_PRO"})

TIER_DEFAULT_FEATURES: dict[str, list[str]] = {
    "COMMUNITY": [],
    "PRO": ["UDS_ACTIVE"],
    "WORKSHOP": ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"],
    # Billing price list may say FLEET; the DB enum and edge lease only have WORKSHOP.
    "FLEET": ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"],
}

ISSUER = "obd2-cloud-api"
SESSION_AUD = "cloud-api"


class SigningKeyError(RuntimeError):
    """Raised when the process has no usable Ed25519 signing key."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _key_hex() -> str:
    return os.environ.get("CLOUD_SIGNING_PRIVATE_KEY_HEX", "").strip()


def has_signing_key() -> bool:
    raw = _key_hex()
    if len(raw) != 64:
        return False
    try:
        bytes.fromhex(raw)
    except ValueError:
        return False
    return True


def _load_ed25519_private_key():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key_hex = _key_hex()
    if not key_hex:
        raise SigningKeyError(
            "CLOUD_SIGNING_PRIVATE_KEY_HEX is not set; refusing to sign or verify"
        )
    try:
        seed = bytes.fromhex(key_hex)
    except ValueError as exc:
        raise SigningKeyError("CLOUD_SIGNING_PRIVATE_KEY_HEX is not valid hex") from exc
    if len(seed) != 32:
        raise SigningKeyError(
            f"CLOUD_SIGNING_PRIVATE_KEY_HEX must be 32 bytes (64 hex chars), got {len(seed)}"
        )
    return Ed25519PrivateKey.from_private_bytes(seed)


def get_public_jwk() -> dict[str, Any]:
    """Returns the active Ed25519 public key in JWK format (no raw_hex helper)."""
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
    }


def public_key_raw() -> bytes:
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    return _load_ed25519_private_key().public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)


def _sign_payload(header: dict[str, Any], payload: dict[str, Any]) -> str:
    signing_input = (
        f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}."
        f"{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    )
    priv = _load_ed25519_private_key()
    sig = priv.sign(signing_input.encode("ascii"))
    return f"{signing_input}.{_b64url(sig)}"


def normalize_tier(tier: str) -> str:
    """Map a billing/price tier onto the edge/DB enum (FLEET -> WORKSHOP)."""
    norm = (tier or "COMMUNITY").upper()
    if norm == "FLEET":
        return "WORKSHOP"
    if norm not in {"COMMUNITY", "PRO", "WORKSHOP"}:
        return "COMMUNITY"
    return norm


def features_for_tier(tier: str, requested: list[str] | None = None) -> list[str]:
    allowed = [f for f in TIER_DEFAULT_FEATURES.get(tier.upper(), []) if f in KNOWN_FEATURES]
    if requested is None:
        return list(allowed)
    wanted = {f for f in requested if f in KNOWN_FEATURES}
    return [f for f in allowed if f in wanted]


def issue_edge_lease(
    tenant_id: str,
    user_id: str,
    tier: str = "COMMUNITY",
    features: list[str] | None = None,
    dongle_id: str | None = None,
    aasra_verified: bool = False,
    ttl_s: int = DEFAULT_LEASE_TTL_S,
) -> dict[str, Any]:
    now = int(time.time())
    edge_tier = normalize_tier(tier)
    granted = features_for_tier(tier, features)
    effective_ttl = min(max(ttl_s, 1), DEFAULT_LEASE_TTL_S)
    payload: dict[str, Any] = {
        "iss": ISSUER,
        "aud": "edge-daemon",
        "sub": user_id,
        "user_id": user_id,
        "tenant_id": tenant_id,
        "tier": edge_tier,
        "features": granted,
        "aasra_verified": bool(aasra_verified),
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
        "features": granted,
    }


def issue_pairing_jwt(tenant_id: str, user_id: str, origin: str) -> dict[str, Any]:
    now = int(time.time())
    payload = {
        "iss": ISSUER,
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


def issue_session_jwt(
    tenant_id: str, user_id: str, ttl_s: int = DEFAULT_SESSION_TTL_S
) -> dict[str, Any]:
    now = int(time.time())
    effective_ttl = min(max(ttl_s, 1), DEFAULT_SESSION_TTL_S)
    payload = {
        "iss": ISSUER,
        "aud": SESSION_AUD,
        "sub": user_id,
        "user_id": user_id,
        "tenant_id": tenant_id,
        "nbf": now,
        "iat": now,
        "exp": now + effective_ttl,
    }
    token = _sign_payload({"alg": "EdDSA", "typ": "JWT", "kid": PINNED_KID}, payload)
    return {"access_token": token, "token_type": "bearer", "expires_at": payload["exp"]}


def verify_session_jwt(token: str) -> dict[str, Any]:
    """Verify a compact Ed25519 session JWT. Fails closed on any defect."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError as exc:
        raise SigningKeyError("malformed session token") from exc
    try:
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        signature = _b64url_decode(sig_b64)
    except (ValueError, json.JSONDecodeError) as exc:
        raise SigningKeyError("malformed session token") from exc
    if header.get("alg") != "EdDSA":
        raise SigningKeyError("unsupported session token algorithm")
    pub = _load_ed25519_private_key().public_key()
    assert isinstance(pub, Ed25519PublicKey)
    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    try:
        pub.verify(signature, signing_input)
    except InvalidSignature as exc:
        raise SigningKeyError("invalid session token signature") from exc
    now = int(time.time())
    if payload.get("iss") != ISSUER or payload.get("aud") != SESSION_AUD:
        raise SigningKeyError("session token audience mismatch")
    if int(payload.get("nbf", 0)) > now + 30:
        raise SigningKeyError("session token not yet valid")
    if int(payload.get("exp", 0)) < now:
        raise SigningKeyError("session token expired")
    if not payload.get("tenant_id") or not payload.get("user_id"):
        raise SigningKeyError("session token missing identity")
    return payload
