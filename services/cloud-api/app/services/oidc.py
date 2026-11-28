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
4. The person is found by (iss, sub). If not, and an account already uses the
   token's email, nothing is linked on the provider's word: a pending link
   request is made (``LinkRequired``) that the account holder confirms either
   signed in to RootCause (password or an existing session) or through a
   single-use link emailed to the account's address; the owner is emailed when
   the link is made. Failing both, a new account is made from a *verified*
   email (into the invite's workshop when the sign-in came from an invite).

Endpoints come from ``{OIDC_ISSUER}/.well-known/openid-configuration``. Issuers
must be https, except http://localhost for the dev provider in
tools/dev-oidc-provider. See docs/dev/sign-in-oidc.md.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
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

log = logging.getLogger(__name__)

STATE_TTL = timedelta(minutes=10)
LINK_TTL = timedelta(minutes=30)
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


GOOGLE_ISSUER = "https://accounts.google.com"


def config() -> OidcConfig | None:
    s = get_settings()
    if s.oidc_issuer and s.oidc_client_id and s.oidc_redirect_uri:
        if s.google_client_id:
            _warn_once(
                "GOOGLE_CLIENT_ID is ignored because OIDC_ISSUER is set; one sign-in "
                "provider is offered at a time (docs/dev/sign-in-oidc.md)"
            )
        return OidcConfig(
            issuer=s.oidc_issuer.rstrip("/"),
            client_id=s.oidc_client_id,
            client_secret=s.oidc_client_secret,
            redirect_uri=s.oidc_redirect_uri,
            scopes=s.oidc_scopes or "openid email profile",
            provider_name=s.oidc_provider_name or "single sign-on",
            logout_url=s.oidc_logout_url,
        )
    if s.google_client_id:
        redirect = s.oidc_redirect_uri or f"{s.public_app_url.rstrip('/')}/auth/callback"
        return OidcConfig(
            issuer=GOOGLE_ISSUER,
            client_id=s.google_client_id,
            client_secret=s.google_client_secret,
            redirect_uri=redirect,
            scopes="openid email profile",
            provider_name="Google",
            logout_url="",
        )
    return None


_warned: set[str] = set()


def _warn_once(message: str) -> None:
    if message not in _warned:
        _warned.add(message)
        log.warning(message)


# Google documents both spellings of its issuer in ID tokens.
_ISSUER_ALIASES = {GOOGLE_ISSUER: {GOOGLE_ISSUER, "accounts.google.com"}}


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


APP_STATE_PREFIX = "m."
_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")


def start(
    *, return_to: str | None, invite_token: str | None, client_challenge: str | None = None
) -> dict:
    """``client_challenge`` (base64url SHA-256 of a verifier the Android app keeps)
    marks a sign-in started from the app: its state starts with ``m.`` so the web
    callback page hands it back to the app, and only that verifier can redeem it."""
    cfg = _require()
    if client_challenge is not None and not _CHALLENGE.match(client_challenge):
        raise HTTPException(status_code=422, detail="client_challenge must be S256, base64url")
    disc = discovery(cfg)
    state = (APP_STATE_PREFIX if client_challenge else "") + secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(24)
    verifier = secrets.token_urlsafe(48)
    now = datetime.now(UTC)
    with owner_engine().begin() as conn:
        conn.execute(text("DELETE FROM oidc_login_states WHERE expires_at < :t"), {"t": now})
        conn.execute(
            text(
                "INSERT INTO oidc_login_states "
                "(state_hash, nonce, code_verifier, return_to, invite_token, expires_at, "
                "client_challenge) VALUES (:h, :n, :v, :r, :i, :e, :c)"
            ),
            {
                "h": _hash(state),
                "n": nonce,
                "v": verifier,
                "r": safe_return_to(return_to),
                "i": invite_token,
                "e": now + STATE_TTL,
                "c": client_challenge,
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
                    "RETURNING nonce, code_verifier, return_to, invite_token, client_challenge"
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
    auth = None
    if cfg.client_secret:
        if cfg.issuer == GOOGLE_ISSUER:
            form["client_secret"] = cfg.client_secret
        else:
            auth = (cfg.client_id, cfg.client_secret)
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
            issuer=sorted(_ISSUER_ALIASES.get(cfg.issuer, {cfg.issuer})),
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


def _check_app_verifier(challenge: str | None, verifier: str | None) -> None:
    if not challenge:
        return
    if not verifier or not hmac.compare_digest(
        _b64(hashlib.sha256(verifier.encode()).digest()), challenge
    ):
        inc("auth_oidc_app_verifier_refused")
        raise HTTPException(
            status_code=401,
            detail="This sign-in was started in the RootCause app. Finish it there.",
        )


def finish(*, code: str, state: str, client_verifier: str | None = None) -> SignedIn:
    from app.services.identity import IdentityError, normalize_email

    cfg = _require()
    st = _consume_state(state)
    _check_app_verifier(st.get("client_challenge"), client_verifier)
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

    link_to: UUID | None = None
    with owner_engine().begin() as conn:
        row = conn.execute(
            text("SELECT id FROM users WHERE oidc_issuer = :i AND oidc_subject = :s"),
            {"i": cfg.issuer, "s": sub},
        ).one_or_none()
        user_id: UUID | None = row[0] if row else None
        if user_id is None and email:
            existing = conn.execute(
                text("SELECT id, oidc_subject FROM users WHERE email = :e"),
                {"e": email},
            ).one_or_none()
            if existing is not None:
                if existing[1] is not None:
                    raise HTTPException(
                        status_code=409,
                        detail="This email is already linked to a different sign-in account.",
                    )
                # Review H3: never link on the provider's say-so. The account holder
                # confirms (signed in, or from their mailbox) before anything changes.
                link_to = existing[0]
        if user_id is not None:
            conn.execute(
                text(
                    "UPDATE users SET last_login_at = :t, failed_logins = 0, locked_until = NULL "
                    "WHERE id = :id"
                ),
                {"t": now, "id": user_id},
            )

    if link_to is not None and email:
        # In its own committed transaction, so the request survives the 409.
        with owner_engine().begin() as conn:
            pending = _request_link(conn, cfg, sub, link_to, email, st.get("invite_token"))
        raise pending

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


class LinkRequired(Exception):
    """A provider sign-in matched an existing account by email; it needs confirming."""

    def __init__(self, *, link_token: str, email: str, provider: str, email_sent: bool) -> None:
        super().__init__("link_required")
        self.link_token = link_token
        self.email = email
        self.provider = provider
        self.email_sent = email_sent

    def detail(self) -> dict[str, Any]:
        where = (
            f"We've also emailed a confirmation link to {mask_email(self.email)}."
            if self.email_sent
            else "Sign in with your password to confirm."
        )
        return {
            "code": "link_required",
            "message": (
                f"An account with this email already exists. To use {self.provider} for it, "
                f"sign in to that account to confirm. {where}"
            ),
            "link_token": self.link_token,
            "provider": self.provider,
            "email_sent": self.email_sent,
            "email_hint": mask_email(self.email),
        }


def mask_email(email: str) -> str:
    local, _, domain = email.partition("@")
    return f"{local[:1]}***@{domain}" if domain else "***"


def _request_link(
    conn, cfg: OidcConfig, sub: str, user_id: UUID, email: str, invite: str | None
) -> LinkRequired:
    from app.services import email as mail

    now = datetime.now(UTC)
    session_token = secrets.token_urlsafe(32)
    email_token = secrets.token_urlsafe(32)
    conn.execute(text("DELETE FROM oidc_link_requests WHERE expires_at < :t"), {"t": now})
    conn.execute(
        text(
            "INSERT INTO oidc_link_requests (id, user_id, oidc_issuer, oidc_subject, "
            "provider_name, session_token_hash, email_token_hash, invite_token, expires_at) "
            "VALUES (:id, :u, :i, :s, :p, :sh, :eh, :inv, :e)"
        ),
        {
            "id": uuid4(),
            "u": user_id,
            "i": cfg.issuer,
            "s": sub,
            "p": cfg.provider_name,
            "sh": _hash(session_token),
            "eh": _hash(email_token),
            "inv": invite,
            "e": now + LINK_TTL,
        },
    )
    base = get_settings().public_app_url.rstrip("/")
    sent = mail.send_email(
        mail.link_confirm_email(
            to=email,
            provider=cfg.provider_name,
            url=f"{base}/auth/link?token={email_token}",
            minutes=int(LINK_TTL.total_seconds() // 60),
        )
    ).sent
    inc("auth_oidc_link_requested")
    return LinkRequired(
        link_token=session_token, email=email, provider=cfg.provider_name, email_sent=sent
    )


@dataclass(frozen=True)
class Linked:
    user_id: UUID
    provider: str
    invite_token: str | None


def confirm_link(*, token: str, via: str, user_id: UUID | None = None) -> Linked:
    """Make a pending link. ``via='session'``: ``token`` is the link token handed to
    the browser and ``user_id`` the signed-in account, which must be the one the
    request is for. ``via='email'``: ``token`` came from the emailed link."""
    column = "session_token_hash" if via == "session" else "email_token_hash"
    now = datetime.now(UTC)
    gone = HTTPException(
        status_code=400,
        detail=(
            "That link request has expired or was already used. Sign in with the provider again."
        ),
    )
    with owner_engine().begin() as conn:
        row = conn.execute(
            text(
                f"SELECT id, user_id, oidc_issuer, oidc_subject, provider_name, invite_token "  # noqa: S608 - fixed column
                f"FROM oidc_link_requests WHERE {column} = :h AND used_at IS NULL "
                "AND expires_at > :t FOR UPDATE"
            ),
            {"h": _hash(token), "t": now},
        ).one_or_none()
        if row is None:
            raise gone
        if via == "session" and row.user_id != user_id:
            raise HTTPException(
                status_code=403,
                detail="Sign in to the account this request is for, then confirm again.",
            )
        taken = conn.execute(
            text("SELECT 1 FROM users WHERE oidc_issuer = :i AND oidc_subject = :s"),
            {"i": row.oidc_issuer, "s": row.oidc_subject},
        ).one_or_none()
        target = conn.execute(
            text("SELECT email, oidc_subject FROM users WHERE id = :id FOR UPDATE"),
            {"id": row.user_id},
        ).one_or_none()
        if taken is not None or target is None or target.oidc_subject is not None:
            conn.execute(
                text("UPDATE oidc_link_requests SET used_at = :t WHERE id = :id"),
                {"t": now, "id": row.id},
            )
            raise HTTPException(
                status_code=409, detail="This account or sign-in is already linked elsewhere."
            )
        conn.execute(
            text("UPDATE users SET oidc_issuer = :i, oidc_subject = :s WHERE id = :id"),
            {"i": row.oidc_issuer, "s": row.oidc_subject, "id": row.user_id},
        )
        # Every outstanding request for this account dies with the one used.
        conn.execute(
            text(
                "UPDATE oidc_link_requests SET used_at = :t WHERE user_id = :u AND used_at IS NULL"
            ),
            {"t": now, "u": row.user_id},
        )
        email_to = target.email
    from app.services import email as mail

    base = get_settings().public_app_url.rstrip("/")
    mail.send_email(
        mail.link_made_email(to=email_to, provider=row.provider_name, url=f"{base}/home")
    )
    inc("auth_oidc_linked")
    log.info("oidc identity linked user=%s provider=%s via=%s", row.user_id, row.provider_name, via)
    return Linked(user_id=row.user_id, provider=row.provider_name, invite_token=row.invite_token)


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
