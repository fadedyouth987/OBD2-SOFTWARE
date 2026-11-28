"""Google as the sign-in provider (GOOGLE_CLIENT_ID shorthand; review H3 and L1)."""

from __future__ import annotations

import os
import time
import uuid
from urllib.parse import parse_qs

import httpx
import jwt
import pytest

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.config import get_settings  # noqa: E402
from app.services import oidc  # noqa: E402
from tests.test_oidc import FakeCognito  # noqa: E402

GOOGLE_CLIENT = "123-test.apps.example"
GOOGLE_SECRET = "google-secret-not-real"


class FakeGoogle(FakeCognito):
    def __init__(self) -> None:
        super().__init__()
        self.token_forms: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "issuer": oidc.GOOGLE_ISSUER,
                    "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
                    "token_endpoint": "https://oauth2.googleapis.com/token",
                    "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
                },
            )
        if path == "/oauth2/v3/certs":
            return httpx.Response(200, json=self.jwks())
        if path == "/token":
            self.token_forms.append(
                {"auth": request.headers.get("authorization"), **parse_qs(request.content.decode())}
            )
            return httpx.Response(200, json={"id_token": "unused"})
        return httpx.Response(404)

    def token(self, *, iss: str, nonce: str) -> str:
        now = int(time.time())
        claims = {
            "iss": iss,
            "aud": GOOGLE_CLIENT,
            "sub": str(uuid.uuid4()),
            "iat": now,
            "exp": now + 600,
            "nonce": nonce,
            "email": "someone@gmail.com",
            "email_verified": True,
        }
        return jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": self.kid})


@pytest.fixture
def google(monkeypatch):
    monkeypatch.setenv("OIDC_ISSUER", "")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", GOOGLE_CLIENT)
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", GOOGLE_SECRET)
    monkeypatch.setenv("PUBLIC_APP_URL", "https://app.example.com")
    get_settings.cache_clear()
    fake = FakeGoogle()
    oidc.set_http_for_tests(lambda: httpx.Client(transport=httpx.MockTransport(fake.handler)))
    yield fake
    oidc.set_http_for_tests(None)
    get_settings.cache_clear()


def test_google_shorthand_config(google):
    cfg = oidc.config()
    assert cfg is not None
    assert (cfg.issuer, cfg.provider_name) == (oidc.GOOGLE_ISSUER, "Google")
    assert cfg.redirect_uri == "https://app.example.com/auth/callback"


@pytest.mark.parametrize("iss", ["https://accounts.google.com", "accounts.google.com"])
def test_both_google_issuer_spellings_verify(google, iss):
    cfg = oidc.config()
    claims = oidc.verify_id_token(cfg, google.token(iss=iss, nonce="n1"), nonce="n1")
    assert claims["email"] == "someone@gmail.com"


def test_other_issuers_still_refused(google):
    cfg = oidc.config()
    with pytest.raises(Exception) as err:
        oidc.verify_id_token(cfg, google.token(iss="https://evil.example", nonce="n"), nonce="n")
    assert getattr(err.value, "status_code", None) == 401


def test_google_gets_the_secret_in_the_form_body(google):
    cfg = oidc.config()
    oidc._exchange(cfg, "code-1", "verifier-1")
    form = google.token_forms[-1]
    assert form["auth"] is None and form["client_secret"] == [GOOGLE_SECRET]


def test_cognito_wins_when_both_are_set(google, monkeypatch, caplog):
    monkeypatch.setenv("OIDC_ISSUER", "https://cognito-idp.ap-southeast-2.amazonaws.com/p")
    monkeypatch.setenv("OIDC_CLIENT_ID", "c")
    monkeypatch.setenv("OIDC_REDIRECT_URI", "http://localhost:3000/auth/callback")
    get_settings.cache_clear()
    oidc._warned.clear()
    with caplog.at_level("WARNING"):
        cfg = oidc.config()
    assert cfg.provider_name != "Google"
    assert "GOOGLE_CLIENT_ID is ignored" in caplog.text
