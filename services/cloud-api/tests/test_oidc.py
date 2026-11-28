"""OIDC sign-in against an in-process fake Cognito: PKCE, state, and ID token checks."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
import uuid
from urllib.parse import parse_qs, urlparse

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.config import get_settings  # noqa: E402
from app.db.session import owner_engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services import oidc  # noqa: E402

ISSUER = "https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_TEST"
CLIENT = "test-client-id"
SECRET = "test-client-secret-not-real"
REDIRECT = "http://localhost:3000/auth/callback"
PASSWORD = "correct horse battery"


class FakeCognito:
    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.kid = "k1"
        self.codes: dict[str, dict] = {}
        self.overrides: dict = {}
        self.alg = "RS256"
        self.sign_key = None

    def jwks(self) -> dict:
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        return {"keys": [{**jwk, "kid": self.kid, "alg": "RS256", "use": "sig"}]}

    def issue_code(self, authorize_url: str, **claims) -> tuple[str, str]:
        q = parse_qs(urlparse(authorize_url).query)
        assert q["client_id"] == [CLIENT] and q["redirect_uri"] == [REDIRECT]
        assert q["code_challenge_method"] == ["S256"] and q["response_type"] == ["code"]
        code = uuid.uuid4().hex
        self.codes[code] = {
            "challenge": q["code_challenge"][0],
            "nonce": q["nonce"][0],
            "claims": claims,
        }
        return code, q["state"][0]

    def id_token(self, entry: dict) -> str:
        now = int(time.time())
        claims = {
            "iss": ISSUER,
            "aud": CLIENT,
            "sub": entry["claims"].pop("sub", str(uuid.uuid4())),
            "iat": now,
            "exp": now + 3600,
            "token_use": "id",
            "nonce": entry["nonce"],
            "email_verified": True,
            **entry["claims"],
            **self.overrides,
        }
        claims = {k: v for k, v in claims.items() if v is not None}
        if self.alg == "HS256":
            return jwt.encode(claims, "x" * 32, algorithm="HS256", headers={"kid": self.kid})
        return jwt.encode(
            claims, self.sign_key or self.key, algorithm="RS256", headers={"kid": self.kid}
        )

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/.well-known/openid-configuration"):
            return httpx.Response(
                200,
                json={
                    "issuer": ISSUER,
                    "authorization_endpoint": "https://auth.example.com/oauth2/authorize",
                    "token_endpoint": "https://auth.example.com/oauth2/token",
                    "jwks_uri": f"{ISSUER}/.well-known/jwks.json",
                },
            )
        if path.endswith("/jwks.json"):
            return httpx.Response(200, json=self.jwks())
        if path == "/oauth2/token":
            expected = base64.b64encode(f"{CLIENT}:{SECRET}".encode()).decode()
            if request.headers.get("authorization") != f"Basic {expected}":
                return httpx.Response(401, json={"error": "invalid_client"})
            form = parse_qs(request.content.decode())
            entry = self.codes.pop(form["code"][0], None)
            if entry is None:
                return httpx.Response(400, json={"error": "invalid_grant"})
            verifier = form["code_verifier"][0].encode()
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier).digest()).rstrip(b"=").decode()
            )
            if challenge != entry["challenge"]:
                return httpx.Response(400, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"id_token": self.id_token(entry)})
        return httpx.Response(404)


@pytest.fixture
def idp(monkeypatch):
    try:
        with owner_engine().connect() as c:
            c.execute(text("SELECT state_hash FROM oidc_login_states LIMIT 0"))
    except Exception:  # noqa: BLE001
        pytest.skip("needs Postgres migrated to 011")
    monkeypatch.setenv("OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("OIDC_CLIENT_ID", CLIENT)
    monkeypatch.setenv("OIDC_CLIENT_SECRET", SECRET)
    monkeypatch.setenv("OIDC_REDIRECT_URI", REDIRECT)
    monkeypatch.setenv("OIDC_PROVIDER_NAME", "AWS Cognito")
    monkeypatch.setenv("OIDC_LOGOUT_URL", "")
    get_settings.cache_clear()
    fake = FakeCognito()
    oidc.set_http_for_tests(lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
    yield fake
    oidc.set_http_for_tests(None)
    get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app)


def _email() -> str:
    return f"sso-{uuid.uuid4().hex[:10]}@example.com"


def _sign_in(client, idp, *, return_to=None, invite=None, **claims):
    params = {}
    if return_to:
        params["return_to"] = return_to
    if invite:
        params["invite_token"] = invite
    start = client.get("/api/v1/auth/oidc/start", params=params)
    assert start.status_code == 200, start.text
    url = start.json()["authorize_url"]
    assert url.startswith("https://auth.example.com/oauth2/authorize?")
    code, state = idp.issue_code(url, **claims)
    return client.post("/api/v1/auth/oidc/callback", json={"code": code, "state": state}), state


def test_config_reports_providers(client, idp):
    body = client.get("/api/v1/auth/config").json()
    assert body["password_enabled"] is True
    assert body["oidc"] == {"enabled": True, "provider_name": "AWS Cognito", "logout_url": None}
    assert "secret" not in json.dumps(body).lower()


def test_new_user_signs_up_through_cognito(client, idp):
    email = _email()
    res, state = _sign_in(client, idp, return_to="/jobs", email=email, name="Sam Sparks")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["created"] is True and body["return_to"] == "/jobs"
    me = client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {body['access_token']}"}
    ).json()
    assert me["user"]["email"] == email
    assert me["user"].get("display_name", "Sam Sparks") == "Sam Sparks"
    # The state is single-use.
    again = client.post("/api/v1/auth/oidc/callback", json={"code": "x", "state": state})
    assert again.status_code == 400
    # Second sign-in with the same subject finds the same user.
    sub = str(uuid.uuid4())
    first, _ = _sign_in(client, idp, sub=sub, email=_email())
    second, _ = _sign_in(client, idp, sub=sub, email=_email())
    assert first.json()["user_id"] == second.json()["user_id"]
    assert second.json()["created"] is False


RUN = uuid.uuid4().hex[:8]
SUB = {
    n: f"{n}-{RUN}"
    for n in ("s-1", "holder-sub", "mailbox-sub", "late-sub", "first-sub", "second-sub")
}


class Recorder:
    name = "recorder"

    def __init__(self) -> None:
        self.sent: list = []

    def send(self, message, *, sender, reply_to):
        self.sent.append(message)
        return "id"


@pytest.fixture
def outbox():
    from app.services import email as email_service

    rec = Recorder()
    email_service.set_provider_for_tests(rec)
    yield rec
    email_service.set_provider_for_tests(None)


def _linked_subject(user_id: str):
    with owner_engine().connect() as c:
        return c.execute(
            text("SELECT oidc_subject FROM users WHERE id = :id"), {"id": user_id}
        ).scalar_one()


def _token_from(message) -> str:
    return parse_qs(urlparse(message.text.split("account: ")[1].split()[0]).query)["token"][0]


def test_existing_account_is_never_linked_on_the_providers_word(client, idp, outbox):
    """Review H3: a matching verified email alone links nothing; the holder confirms."""
    email = _email()
    made = client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD})
    assert made.status_code == 201
    for verified in (True, False):
        res, _ = _sign_in(client, idp, email=email.upper(), email_verified=verified, sub=SUB["s-1"])
        assert res.status_code == 409, res.text
        detail = res.json()["detail"]
        assert detail["code"] == "link_required" and detail["provider"] == "AWS Cognito"
        assert detail["email_sent"] is True and email[1:] not in detail["email_hint"]
        assert "access_token" not in res.json()
    assert _linked_subject(made.json()["user_id"]) is None
    asks = [m for m in outbox.sent if m.tags.get("kind") == "oidc_link_confirm"]
    assert len(asks) == 2 and all(m.to == email for m in asks)


def test_signed_in_holder_confirms_and_is_notified(client, idp, outbox):
    email = _email()
    made = client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD}).json()
    res, _ = _sign_in(client, idp, email=email, sub=SUB["holder-sub"])
    token = res.json()["detail"]["link_token"]
    # Someone else signed in can't use it.
    other = client.post(
        "/api/v1/auth/signup", json={"email": _email(), "password": PASSWORD}
    ).json()
    wrong = client.post(
        "/api/v1/auth/oidc/link/confirm",
        json={"token": token},
        headers={"Authorization": f"Bearer {other['access_token']}"},
    )
    assert wrong.status_code == 403
    assert client.post("/api/v1/auth/oidc/link/confirm", json={"token": token}).status_code == 401
    session = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD}).json()
    ok = client.post(
        "/api/v1/auth/oidc/link/confirm",
        json={"token": token},
        headers={"Authorization": f"Bearer {session['access_token']}"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["linked"] is True
    assert _linked_subject(made["user_id"]) == SUB["holder-sub"]
    done = [m for m in outbox.sent if m.tags.get("kind") == "oidc_linked"]
    assert [m.to for m in done] == [email]
    again, _ = _sign_in(client, idp, email=email, sub=SUB["holder-sub"])
    assert again.status_code == 200 and again.json()["user_id"] == made["user_id"]
    reuse = client.post(
        "/api/v1/auth/oidc/link/confirm",
        json={"token": token},
        headers={"Authorization": f"Bearer {session['access_token']}"},
    )
    assert reuse.status_code == 400


def test_emailed_link_confirms_once(client, idp, outbox):
    email = _email()
    made = client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD}).json()
    _sign_in(client, idp, email=email, sub=SUB["mailbox-sub"])
    ask = next(m for m in outbox.sent if m.tags.get("kind") == "oidc_link_confirm")
    token = _token_from(ask)
    ok = client.post("/api/v1/auth/oidc/link/email-confirm", json={"token": token})
    assert ok.status_code == 200, ok.text
    assert "access_token" not in ok.json()  # it links; it never signs anyone in
    assert _linked_subject(made["user_id"]) == SUB["mailbox-sub"]
    again = client.post("/api/v1/auth/oidc/link/email-confirm", json={"token": token})
    assert again.status_code == 400


def test_link_requests_expire(client, idp, outbox):
    email = _email()
    client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD})
    _sign_in(client, idp, email=email, sub=SUB["late-sub"])
    token = _token_from(next(m for m in outbox.sent if m.tags.get("kind") == "oidc_link_confirm"))
    with owner_engine().begin() as c:
        c.execute(
            text(
                "UPDATE oidc_link_requests SET expires_at = now() - interval '1 minute' "
                "WHERE oidc_subject = :s"
            ),
            {"s": SUB["late-sub"]},
        )
    res = client.post("/api/v1/auth/oidc/link/email-confirm", json={"token": token})
    assert res.status_code == 400


def test_email_already_linked_elsewhere_is_refused(client, idp, outbox):
    email = _email()
    first, _ = _sign_in(client, idp, email=email, sub=SUB["first-sub"])
    assert first.status_code == 200
    other, _ = _sign_in(client, idp, email=email, sub=SUB["second-sub"])
    assert other.status_code == 409
    assert other.json()["detail"] == "This email is already linked to a different sign-in account."


@pytest.mark.parametrize(
    "override, detail",
    [
        ({"aud": "someone-else"}, "invalid"),
        ({"iss": "https://evil.example.com"}, "invalid"),
        ({"exp": int(time.time()) - 3600}, "expired"),
        ({"nonce": "wrong"}, "nonce"),
        ({"token_use": "access"}, "ID token"),
        ({"exp": None}, "invalid"),
    ],
)
def test_bad_id_tokens_are_refused(client, idp, override, detail):
    idp.overrides = override
    res, _ = _sign_in(client, idp, email=_email())
    assert res.status_code == 401, res.text
    assert detail.lower() in res.json()["detail"].lower()


def test_wrong_signature_and_algorithm_refused(client, idp):
    idp.sign_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    res, _ = _sign_in(client, idp, email=_email())
    assert res.status_code == 401
    idp.sign_key = None
    idp.alg = "HS256"
    res, _ = _sign_in(client, idp, email=_email())
    assert res.status_code == 401 and "RS256" in res.json()["detail"]


def test_unverified_new_email_and_tampered_code(client, idp):
    res, _ = _sign_in(client, idp, email=_email(), email_verified=False)
    assert res.status_code == 403
    start = client.get("/api/v1/auth/oidc/start").json()["authorize_url"]
    _, state = idp.issue_code(start, email=_email())
    bad = client.post("/api/v1/auth/oidc/callback", json={"code": "not-issued", "state": state})
    assert bad.status_code == 401


def test_return_to_is_same_site_only(client, idp):
    for bad in ("https://evil.example.com", "//evil.example.com", "/\\evil"):
        res, _ = _sign_in(client, idp, return_to=bad, email=_email())
        assert res.json()["return_to"] == "/"


def test_invite_through_sso_joins_the_workshop(client, idp):
    owner = client.post(
        "/api/v1/auth/signup", json={"email": _email(), "password": PASSWORD}
    ).json()
    h = {"Authorization": f"Bearer {owner['access_token']}"}
    client.post("/api/v1/auth/dev-grant-plan", json={"tier": "WORKSHOP"}, headers=h)
    invitee = _email()
    inv = client.post("/api/v1/team/invites", json={"email": invitee, "role": "TECH"}, headers=h)
    assert inv.status_code in (200, 201), inv.text
    token = inv.json()["token"]
    res, _ = _sign_in(client, idp, invite=token, email=invitee)
    assert res.status_code == 200, res.text
    assert res.json()["tenant_id"] == owner["tenant_id"]
    assert [w["tenant_id"] for w in res.json()["workspaces"]] == [owner["tenant_id"]]


def test_password_sign_in_can_be_turned_off(client, idp, monkeypatch):
    monkeypatch.setenv("AUTH_PASSWORD_ENABLED", "false")
    get_settings.cache_clear()
    res = client.post("/api/v1/auth/login", json={"email": _email(), "password": PASSWORD})
    assert res.status_code == 403 and "AWS Cognito" in res.json()["detail"]
    res = client.post("/api/v1/auth/signup", json={"email": _email(), "password": PASSWORD})
    assert res.status_code == 403
    assert client.get("/api/v1/auth/config").json()["password_enabled"] is False
    ok, _ = _sign_in(client, idp, email=_email())
    assert ok.status_code == 200


def test_not_configured(client, monkeypatch):
    monkeypatch.setenv("OIDC_ISSUER", "")
    get_settings.cache_clear()
    assert client.get("/api/v1/auth/oidc/start").status_code == 404
    assert client.get("/api/v1/auth/config").json()["oidc"]["enabled"] is False
