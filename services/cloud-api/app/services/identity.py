"""Password sign-in, sign-up and workspace membership lookups.

Users are global and invisible to the tenant-scoped (RLS) role until they belong
to a workspace, so the lookups that happen *before* a tenant is known (sign-in by
email, the list of a user's workspaces) use the owner connection, the same one
migrations use. Nothing else in the request path does.

Passwords are hashed with scrypt (N=2^15, r=8, p=1, 16-byte salt), stored as
``scrypt$N$r$p$salt_b64$hash_b64``. Five wrong passwords lock the account for 15
minutes; the response never says whether the email exists.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import text

from app.db.session import owner_engine

SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
MIN_PASSWORD_LEN = 10
MAX_PASSWORD_LEN = 256
MAX_FAILED_LOGINS = 5
LOCKOUT = timedelta(minutes=15)

_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


class IdentityError(Exception):
    """A sign-in or sign-up problem that is safe to show the user."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def normalize_email(email: str) -> str:
    value = email.strip().lower()
    if not _EMAIL.fullmatch(value) or len(value) > 254:
        raise IdentityError("Enter a valid email address")
    return value


def check_password_policy(password: str) -> None:
    if len(password) < MIN_PASSWORD_LEN:
        raise IdentityError(f"Use at least {MIN_PASSWORD_LEN} characters for the password")
    if len(password) > MAX_PASSWORD_LEN:
        raise IdentityError("That password is too long")
    if password.strip() == "" or len(set(password)) < 4:
        raise IdentityError("That password is too easy to guess")


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        maxmem=64 * 1024 * 1024,
        dklen=32,
    )
    b64 = base64.b64encode
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${b64(salt).decode()}${b64(digest).decode()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        # Burn comparable time so a missing account is not faster than a wrong password.
        hash_password(password, salt=b"\x00" * 16)
        return False
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        digest = hashlib.scrypt(
            password.encode("utf-8"),
            salt=salt,
            n=int(n),
            r=int(r),
            p=int(p),
            maxmem=64 * 1024 * 1024,
            dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected)


@dataclass(frozen=True)
class Workspace:
    tenant_id: UUID
    name: str
    role: str
    tier: str


def workspaces_for(user_id: UUID) -> list[Workspace]:
    with owner_engine().connect() as conn:
        rows = conn.execute(
            text(
                """
                SELECT t.id, t.name, m.role::text, t.subscription_tier::text
                FROM tenant_memberships m JOIN tenants t ON t.id = m.tenant_id
                WHERE m.user_id = :uid
                ORDER BY m.created_at ASC
                """
            ),
            {"uid": user_id},
        ).all()
    return [Workspace(tenant_id=r[0], name=r[1], role=r[2], tier=r[3]) for r in rows]


def user_by_email(email: str) -> dict | None:
    with owner_engine().connect() as conn:
        row = (
            conn.execute(
                text(
                    "SELECT id, email, display_name, password_hash, failed_logins, locked_until "
                    "FROM users WHERE email = :email"
                ),
                {"email": email},
            )
            .mappings()
            .one_or_none()
        )
    return dict(row) if row else None


def user_profile(user_id: UUID) -> dict | None:
    with owner_engine().connect() as conn:
        row = (
            conn.execute(
                text("SELECT id, email, display_name, last_login_at FROM users WHERE id = :id"),
                {"id": user_id},
            )
            .mappings()
            .one_or_none()
        )
    return dict(row) if row else None


def authenticate(email: str, password: str, *, now: datetime | None = None) -> UUID:
    """The user id, or IdentityError (401/423) that never says which part was wrong."""
    now = now or datetime.now(UTC)
    try:
        email = normalize_email(email)
    except IdentityError:
        verify_password(password, None)
        raise IdentityError("Email or password is incorrect", 401) from None
    user = user_by_email(email)
    if user is None:
        verify_password(password, None)
        raise IdentityError("Email or password is incorrect", 401)
    locked_until = user.get("locked_until")
    if locked_until is not None and locked_until > now:
        raise IdentityError(
            "Too many wrong passwords. Try again in 15 minutes or ask your workshop owner.",
            423,
        )
    if not verify_password(password, user.get("password_hash")):
        failed = int(user.get("failed_logins") or 0) + 1
        lock = now + LOCKOUT if failed >= MAX_FAILED_LOGINS else None
        with owner_engine().begin() as conn:
            conn.execute(
                text("UPDATE users SET failed_logins = :f, locked_until = :l WHERE id = :id"),
                {"f": 0 if lock else failed, "l": lock, "id": user["id"]},
            )
        raise IdentityError("Email or password is incorrect", 401)
    with owner_engine().begin() as conn:
        conn.execute(
            text(
                "UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = :now "
                "WHERE id = :id"
            ),
            {"now": now, "id": user["id"]},
        )
    return user["id"]


def set_password(user_id: UUID, password: str) -> None:
    check_password_policy(password)
    with owner_engine().begin() as conn:
        conn.execute(
            text("UPDATE users SET password_hash = :h WHERE id = :id"),
            {"h": hash_password(password), "id": user_id},
        )
