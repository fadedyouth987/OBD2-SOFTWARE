"""A tiny OIDC provider for local development and e2e tests. NOT for production.

It behaves like the parts of AWS Cognito RootCause uses: discovery, an
authorize page (type any email, no password), a token endpoint that checks the
client secret (HTTP Basic) and PKCE, and RS256 ID tokens with ``token_use=id``.
The signing key is made fresh each run and only lives in memory. It listens on
127.0.0.1 only.

    cd services/cloud-api
    uv run python ../../tools/dev-oidc-provider/server.py            # :9400

Then in .env (see docs/dev/sign-in-oidc.md):

    OIDC_ISSUER=http://localhost:9400
    OIDC_CLIENT_ID=rootcause-dev
    OIDC_CLIENT_SECRET=dev-secret-not-for-production
    OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
    OIDC_PROVIDER_NAME=Dev sign-in (Cognito stand-in)
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import secrets
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

PORT = int(os.environ.get("DEV_OIDC_PORT", "9400"))
ISSUER = f"http://localhost:{PORT}"
CLIENT_ID = os.environ.get("DEV_OIDC_CLIENT_ID", "rootcause-dev")
CLIENT_SECRET = os.environ.get("DEV_OIDC_CLIENT_SECRET", "dev-secret-not-for-production")
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
KID = uuid.uuid4().hex[:12]
CODES: dict[str, dict] = {}
SUBJECTS: dict[str, str] = {}  # email -> stable sub for this run


def _jwks() -> dict:
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key()))
    return {"keys": [{**jwk, "kid": KID, "alg": "RS256", "use": "sig"}]}


PAGE = """<!doctype html><meta charset=utf-8><title>Dev sign-in</title>
<style>body{{font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem}}
label{{display:block;margin:.8rem 0 .2rem}}input{{width:100%;padding:.5rem;font:inherit}}
button{{margin-top:1rem;padding:.6rem 1rem;font:inherit}}</style>
<h1>Dev sign-in</h1><p>Local stand-in for AWS Cognito. Any email works; nothing is checked.</p>
<form method=post action=/authorize>{hidden}
<label for=email>Email</label><input id=email name=email type=email required value="{email}">
<label for=name>Name</label><input id=name name=name value="">
<label><input type=checkbox name=unverified style="width:auto"> Email not verified</label>
<button type=submit>Continue</button></form>"""


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _form(self) -> dict[str, str]:
        n = int(self.headers.get("Content-Length") or 0)
        return {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/.well-known/openid-configuration":
            return self._json(
                200,
                {
                    "issuer": ISSUER,
                    "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token",
                    "jwks_uri": f"{ISSUER}/jwks.json",
                    "response_types_supported": ["code"],
                    "id_token_signing_alg_values_supported": ["RS256"],
                    "code_challenge_methods_supported": ["S256"],
                },
            )
        if url.path == "/jwks.json":
            return self._json(200, _jwks())
        if url.path == "/authorize":
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            if q.get("client_id") != CLIENT_ID or q.get("code_challenge_method") != "S256":
                return self._json(400, {"error": "invalid_request"})
            keep = ("redirect_uri", "state", "nonce", "code_challenge")
            hidden = "".join(
                f'<input type=hidden name="{k}" value="{html.escape(q.get(k, ""))}">' for k in keep
            )
            data = PAGE.format(hidden=hidden, email=html.escape(q.get("login_hint", ""))).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(data)
            return None
        return self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        if url.path == "/authorize":
            f = self._form()
            code = secrets.token_urlsafe(24)
            email = f.get("email", "").strip().lower()
            CODES[code] = {
                "challenge": f.get("code_challenge"),
                "nonce": f.get("nonce"),
                "redirect_uri": f.get("redirect_uri"),
                "email": email,
                "name": f.get("name", "").strip(),
                "verified": "unverified" not in f,
                "at": time.time(),
            }
            self.send_response(302)
            self.send_header(
                "Location", f"{f['redirect_uri']}?{urlencode({'code': code, 'state': f['state']})}"
            )
            self.end_headers()
            return None
        if url.path == "/token":
            expected = base64.b64encode(f"{CLIENT_ID}:{CLIENT_SECRET}".encode()).decode()
            if self.headers.get("Authorization") != f"Basic {expected}":
                return self._json(401, {"error": "invalid_client"})
            f = self._form()
            entry = CODES.pop(f.get("code", ""), None)
            if entry is None or time.time() - entry["at"] > 300:
                return self._json(400, {"error": "invalid_grant"})
            verifier = f.get("code_verifier", "").encode()
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier).digest()).rstrip(b"=").decode()
            )
            if challenge != entry["challenge"] or f.get("redirect_uri") != entry["redirect_uri"]:
                return self._json(400, {"error": "invalid_grant"})
            now = int(time.time())
            sub = SUBJECTS.setdefault(entry["email"], str(uuid.uuid4()))
            claims = {
                "iss": ISSUER,
                "aud": CLIENT_ID,
                "sub": sub,
                "iat": now,
                "exp": now + 3600,
                "token_use": "id",
                "nonce": entry["nonce"],
                "email": entry["email"],
                "email_verified": entry["verified"],
            }
            if entry["name"]:
                claims["name"] = entry["name"]
            token = jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": KID})
            return self._json(200, {"id_token": token, "token_type": "Bearer", "expires_in": 3600})
        return self._json(404, {"error": "not_found"})

    def log_message(self, fmt: str, *args) -> None:
        print(f"[dev-oidc] {self.command} {self.path.split('?')[0]}", flush=True)


if __name__ == "__main__":
    print(f"dev OIDC provider on {ISSUER} (client {CLIENT_ID})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
