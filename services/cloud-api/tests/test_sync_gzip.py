"""Task 2.2: session sync accepts gzip-compressed batches, within size limits,
and only inflates bodies from a caller with a valid session token."""

from __future__ import annotations

import gzip
import json
import os
import uuid

import pytest

from app.api.gzip_body import MAX_COMPRESSED, MAX_INFLATED
from tests.db_ready import NEEDS_012, migrated_to_012
from tests.test_security import _auth, _dev_session

URL = "/api/v1/sessions/sync"
ORIGIN = "http://localhost:3000"  # in the default EDGE_ALLOWED_ORIGINS


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture(scope="module")
def auth(client) -> dict[str, str]:
    if not migrated_to_012():
        pytest.skip(NEEDS_012)
    return _auth(_dev_session(client)["access_token"])


def _batch() -> dict:
    return {
        "batch_id": f"batch-{uuid.uuid4()}",
        "session_id": f"sess-gz-{uuid.uuid4().hex[:10]}",
        "watermark_us": 1000,
        "telemetry_rows": [{"pid": 12, "value": 800 + i, "name": "rpm"} for i in range(50)],
    }


def test_gzip_batch_is_accepted_and_stored(client, auth):
    batch = _batch()
    body = gzip.compress(json.dumps(batch).encode())
    r = client.post(
        URL,
        content=body,
        headers={**auth, "Content-Encoding": "gzip", "Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted" and r.json()["telemetry_ingested"] == 50
    # The same batch as plain JSON is recognised as the same batch.
    again = client.post(URL, json=batch, headers=auth)
    assert again.json()["status"] == "duplicate_ignored"


@pytest.mark.parametrize(
    "creds",
    [{}, {"Authorization": "Bearer not.a.token"}, {"Authorization": "Basic Zm9vOmJhcg=="}],
    ids=["none", "forged", "not-bearer"],
)
def test_gzip_bodies_are_not_inflated_without_a_valid_session(client, creds):
    """A cheap compressed body can't make the API inflate 32 MiB for an anonymous caller."""
    bomb = gzip.compress(b"[" + b" " * (MAX_INFLATED + 10) + b"]")
    r = client.post(URL, content=bomb, headers={**creds, "Content-Encoding": "gzip"})
    assert r.status_code == 401, r.text


@pytest.mark.parametrize(
    "body, encoding, status",
    [
        (gzip.compress(b"[" + b" " * (MAX_INFLATED + 10) + b"]"), "gzip", 413),
        (os.urandom(MAX_COMPRESSED + 1), "gzip", 413),
        (b"not gzip at all", "gzip", 400),
        (gzip.compress(b'{"batch_id": "x"}')[:-8], "gzip", 400),
        (gzip.compress(b"{}") + b"trailing junk", "gzip", 400),
        (gzip.compress(b"{}") + gzip.compress(b"{}"), "gzip", 400),
        (b"{}", "br", 415),
    ],
    ids=[
        "gzip-bomb",
        "compressed-too-big",
        "corrupt",
        "truncated",
        "trailing-data",
        "second-member",
        "other-encoding",
    ],
)
def test_bad_compressed_bodies_are_refused_before_parsing(client, auth, body, encoding, status):
    r = client.post(URL, content=body, headers={**auth, "Content-Encoding": encoding})
    assert r.status_code == status, r.text
    assert "detail" in r.json()


def test_refusals_carry_cors_headers_for_the_web_app(client, auth):
    r = client.post(
        URL,
        content=b"not gzip",
        headers={**auth, "Content-Encoding": "gzip", "Origin": ORIGIN},
    )
    assert r.status_code == 400
    assert r.headers.get("access-control-allow-origin") == ORIGIN


def test_other_routes_are_not_inflated(client):
    r = client.post(
        "/api/v1/auth/edge-lease", content=b"not gzip", headers={"Content-Encoding": "gzip"}
    )
    assert r.status_code == 401, "untouched: the route's own auth answers"
