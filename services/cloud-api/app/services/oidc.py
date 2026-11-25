"""OpenID Connect sign-in (authorization code + PKCE), built for AWS Cognito.

Flow:

1. ``start()`` makes a one-time ``state`` (stored hashed), a ``nonce`` and a
   PKCE verifier, and returns the provider's authorize URL.
2. The provider sends the browser back to ``OIDC_REDIRECT_URI`` (the web app's
   /auth/callback page) with ``code`` and ``state``.
3. ``finish()`` consumes the state (single use, 10 minutes), swaps the code for
   tokens at the token endpoint (client secret via HTTP Basic, as Cognito
   expects), and checks the ID token: RS256 signature against the provider's
   JWKS, ``iss`` == OIDC_ISSUER, ``aud`` == OIDC_CLIENT_ID, ``exp``/``iat``,
   the nonce, and Cognito's ``token_use`` == "id".
4. The person is found by (iss, sub); failing that an existing account with
   the same *verified* email is linked; failing that a new account is made
   (into the invite's workshop when the sign-in came from an invite link).

Endpoints come from ``{OIDC_ISSUER}/.well-known/openid-configuration``. Issuers
must be https, except http://localhost for the dev provider in
tools/dev-oidc-provider. See docs/dev/sign-in-oidc.md.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlparse
from uuid import UUID, uuid4

import httpx
import jwt
from fastapi import HTTPException
from sqlalchemy import text

from app.config import get_settings
from app.db.session import owner_engine
from app.observability.metrics import inc

STATE_TTL = timedelta(minutes=10)
CACHE_TTL_S = 600
LEEWAY_S = 60

_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}
_http_factory = None  # tests swap in an httpx.Client with a MockTransport


def set_http_for_tests(factory) -> None:
    global _http_factory
    _http_factory = factory
    _cache.clear()


def _http() -> httpx.Client:
    if _http_factory is not None:
        return _http_factory()
    return httpx.Client(timeout=10)


@dataclass(frozen=True)
class OidcConfig:
    issuer: str
    client_id: str
    client_secret: str
    redirect_uri: str
    scopes: str
    provider_name: str
    logout_url: str


def config() -> OidcConfig | None:
    s = get_settings()
    if not (s.oidc_issuer and s.oidc_client_id and s.oidc_redirect_uri):
        return None
    return OidcConfig(
        issuer=s.oidc_issuer.rstrip("/"),
        client_id=s.oidc_client_id,
        client_secret=s.oidc_client_secret,
        redirect_uri=s.oidc_redirect_uri,
        scopes=s.oidc_scopes or "openid email profile",
        provider_name=s.oidc_provider_name or "single sign-on",
        logout_url=s.oidc_logout_url,
    )


def _require() -> OidcConfig:
    cfg = config()
    if cfg is None:
        raise HTTPException(status_code=404, detail="Single sign-on isn't set up on this server")
    return cfg


def _check_url(url: str, what: str) -> str:
    p = urlparse(url)
    local = p.hostname in {"localhost", "127.0.0.1"}
    if p.scheme != "https" and not (p.scheme == "http" and local):
        raise HTTPException(status_code=502, detail=f"The sign-in provider's {what} isn't https")
    return url


def _get_json(url: str, what: str) -> dict:
    try:
        with _http() as http:
            resp = http.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"Couldn't reach the sign-in provider ({what})"
        ) from exc
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"The sign-in provider's {what} answered {resp.status_code}"
        )
    try:
        return resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=f"Bad {what} from the provider") from exc


def _cached(key: str, loader, *, refresh: bool = False):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and not refresh and now - hit[0] < CACHE_TTL_S:
            return hit[1]
    value = loader()
    with _lock:
        _cache[key] = (now, value)
    return value


def discovery(cfg: OidcConfig) -> dict:
    def load() -> dict:
        url = _check_url(f"{cfg.issuer}/.well-known/openid-configuration", "discovery URL")
        doc = _get_json(url, "discovery document")
        if doc.get("issuer", "").rstrip("/") != cfg.issuer:
            raise HTTPException(
                status_code=502, detail="The provider's issuer doesn't match OIDC_ISSUER"
            )
        for field in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
            if not doc.get(field):
                raise HTTPException(status_code=502, detail=f"The provider has no {field}")
            _check_url(doc[field], field)
        return doc

    return _cached(f"disc:{cfg.issuer}", load)


def _jwks(cfg: OidcConfig, *, refresh: bool = False) -> jwt.PyJWKSet:
    uri = discovery(cfg)["jwks_uri"]
    return _cached(
        f"jwks:{uri}", lambda: jwt.PyJWKSet.from_dict(_get_json(uri, "JWKS")), refresh=refresh
    )


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _hash(state: str) -> str:
    return hashlib.sha256(state.encode()).hexdigest()


def safe_return_to(value: str | None) -> str:
    """Only same-site paths: '/jobs/1' yes; '//evil', 'https://…' or '/\\evil' no."""
    if not value or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/"
    return value[:500]


def start(*, return_to: str | None, invite_token: str | None) -> dict:
    cfg = _require()
    disc = discovery(cfg)
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    now = datetime.now(UTC)
    with owner_engine().begin() as conn:
        conn.execute(text("DELETE FROM oidc_login_states WHERE expires_at < :t"), {"t": now})
        conn.execute(
            text(
                "INSERT INTO oidc_login_states "
                "(state_hash, nonce, code_verifier, return_to, invite_token, expires_at) "
                "VALUES (:h, :n, :v, :r, :i, :e)"
            ),
            {
                "h": _hash(state),
                "n": nonce,
                "v": verifier,
                "r": safe_return_to(return_to),
                "i": invite_token,
                "e": now + STATE_TTL,
            },
        )
    params = {
        "response_type": "code",
        "client_id": cfg.client_id,
        "redirect_uri": cfg.redirect_uri,
        "scope": cfg.scopes,
        "state": state,
        "nonce": nonce,
        "code_challenge": _b64(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
    }
    inc("auth_oidc_started")
    return {"authorize_url": f"{disc['authorization_endpoint']}?{urlencode(params)}"}


def _consume_state(state: str) -> dict:
    now = datetime.now(UTC)
    with owner_engine().begin() as conn:
        row = (
            conn.execute(
                text(
                    "UPDATE oidc_login_states SET used_at = :t "
                    "WHERE state_hash = :h AND used_at IS NULL AND expires_at > :t "
                    "RETURNING nonce, code_verifier, return_to, invite_token"
                ),
                {"t": now, "h": _hash(state)},
            )
            .mappings()
            .one_or_none()
        )
    if row is None:
        raise HTTPException(
            status_code=400,
            detail="That sign-in link has expired or was already used. Start again.",
        )
    return dict(row)


def _exchange(cfg: OidcConfig, code: str, verifier: str) -> dict:
    disc = discovery(cfg)
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": cfg.redirect_uri,
        "client_id": cfg.client_id,
        "code_verifier": verifier,
    }
    auth = (cfg.client_id, cfg.client_secret) if cfg.client_secret else None
    try:
        with _http() as http:
            resp = http.post(disc["token_endpoint"], data=form, auth=auth)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="Couldn't reach the sign-in provider") from exc
    if resp.status_code != 200:
        raise HTTPException(
            status_code=401, detail="The sign-in provider didn't accept that sign-in. Start again."
        )
    try:
        body = resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Bad token response from the provider") from exc
    if not body.get("id_token"):
        raise HTTPException(status_code=502, detail="The provider didn't send an ID token")
    return body


def verify_id_token(cfg: OidcConfig, token: str, *, nonce: str) -> dict:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="The ID token is malformed") from exc
    if header.get("alg") != "RS256":
        raise HTTPException(status_code=401, detail="The ID token isn't RS256-signed")
    kid = header.get("kid")

    def find(keyset: jwt.PyJWKSet):
        return next((k for k in keyset.keys if k.key_id == kid), None)

    key = find(_jwks(cfg)) or find(_jwks(cfg, refresh=True))  # key rotation
    if key is None:
        raise HTTPException(status_code=401, detail="The ID token was signed with an unknown key")
    try:
        claims = jwt.decode(
            token,
            key=key.key,
            algorithms=["RS256"],
            audience=cfg.client_id,
            issuer=cfg.issuer,
            leeway=LEEWAY_S,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise HTTPException(status_code=401, detail="The ID token has expired") from exc
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail=f"The ID token is invalid: {exc}") from exc
    if not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise HTTPException(status_code=401, detail="The ID token's nonce doesn't match")
    if "token_use" in claims and claims["token_use"] != "id":
        raise HTTPException(status_code=401, detail="That isn't an ID token")
    if isinstance(claims.get("aud"), list) and claims.get("azp") not in (None, cfg.client_id):
        raise HTTPException(status_code=401, detail="The ID token is for another client")
    return claims


def _verified(claims: dict) -> bool:
    value = claims.get("email_verified")
    return value is True or (isinstance(value, str) and value.lower() == "true")


@dataclass(frozen=True)
class SignedIn:
    user_id: UUID
    tenant_id: UUID | None  # set when an invite (or a new workshop) decides it
    return_to: str
    created: bool


def finish(*, code: str, state: str) -> SignedIn:
    from app.services.identity import IdentityError, normalize_email

    cfg = _require()
    st = _consume_state(state)
    tokens = _exchange(cfg, code, st["code_verifier"])
    claims = verify_id_token(cfg, tokens["id_token"], nonce=st["nonce"])
    sub = str(claims["sub"])
    raw_email = claims.get("email")
    try:
        email = normalize_email(raw_email) if raw_email else None
    except IdentityError:
        email = None
    name = str(claims.get("name") or claims.get("given_name") or "").strip()
    now = datetime.now(UTC)

    with owner_engine().begin() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE oidc_issuer = :i AND oidc_subject = :s"),
            {"i": cfg.issuer, "s": sub},
        ).one_or_none()
        user_id: UUID | None = row[0] if row else None
        if user_id is None and email:
            existing = conn.execute(
                text("SELECT id, oidc_subject FROM users WHERE email = :e FOR UPDATE"),
                {"e": email},
            ).one_or_none()
            if existing is not None:
                if not _verified(claims):
                    raise HTTPException(
                        status_code=403,
                        detail=(
                            "An account with this email exists, but the provider hasn't "
                            "verified the email. Verify it there, then sign in again."
                        ),
                    )
                if existing[1] is not None:
                    raise HTTPException(
                        status_code=409,
                        detail="This email is already linked to a different sign-in account.",
                    )
                conn.execute(
                    text("UPDATE users SET oidc_issuer = :i, oidc_subject = :s WHERE id = :id"),
                    {"i": cfg.issuer, "s": sub, "id": existing[0]},
                )
                user_id = existing[0]
                inc("auth_oidc_linked")
        if user_id is not None:
            conn.execute(
                text(
                    "UPDATE users SET last_login_at = :t, failed_logins = 0, locked_until = NULL "
                    "WHERE id = :id"
                ),
                {"t": now, "id": user_id},
            )

    tenant_id: UUID | None = None
    created = False
    invite = st.get("invite_token")
    if user_id is None:
        if not email or not _verified(claims):
            raise HTTPException(
                status_code=403,
                detail="Your sign-in provider must share a verified email to create an account.",
            )
        user_id, tenant_id = _create_user(cfg, sub, email, name, invite)
        created = True
    elif invite:
        from app.api.v1.team import join_with_invite

        tenant_id = join_with_invite(invite, user_id, email or "")
    inc("auth_oidc_login")
    return SignedIn(
        user_id=user_id, tenant_id=tenant_id, return_to=st["return_to"], created=created
    )


def _create_user(
    cfg: OidcConfig, sub: str, email: str, name: str, invite: str | None
) -> tuple[UUID, UUID]:
    from app.db.models import MembershipRole, Tenant, TenantMembership, User
    from app.db.session import tenant_session

    display = (name or email.split("@", 1)[0])[:120]
    user_id = uuid4()
    user = User(
        id=user_id,
        email=email,
        display_name=display,
        password_hash=None,
        oidc_issuer=cfg.issuer,
        oidc_subject=sub,
        last_login_at=datetime.now(UTC),
    )
    if invite:
        from app.api.v1.team import join_with_invite

        return user_id, join_with_invite(invite, user_id, email, new_user=user)
    tenant_id = uuid4()
    with tenant_session(tenant_id) as session:
        session.add(user)
        session.flush()
        session.add(Tenant(id=tenant_id, name=f"{display}'s workshop"[:200]))
        session.flush()
        session.add(
            TenantMembership(tenant_id=tenant_id, user_id=user_id, role=MembershipRole.OWNER)
        )
    return user_id, tenant_id
