"""Task 2.2: session sync accepts gzip-compressed batches, within size limits."""

from __future__ import annotations

import gzip
import json
import uuid

import pytest

from app.api.gzip_body import MAX_INFLATED
from tests.test_security import _auth, _dev_session, _postgres_up

URL = "/api/v1/sessions/sync"


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


def _batch() -> dict:
    return {
        "batch_id": f"batch-{uuid.uuid4()}",
        "session_id": f"sess-gz-{uuid.uuid4().hex[:10]}",
        "watermark_us": 1000,
        "telemetry_rows": [{"pid": 12, "value": 800 + i, "name": "rpm"} for i in range(50)],
    }


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_gzip_batch_is_accepted_and_stored(client):
    headers = _auth(_dev_session(client)["access_token"])
    batch = _batch()
    body = gzip.compress(json.dumps(batch).encode())
    r = client.post(
        URL,
        content=body,
        headers={**headers, "Content-Encoding": "gzip", "Content-Type": "application/json"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted" and r.json()["telemetry_ingested"] == 50
    # The same batch as plain JSON is recognised as the same batch.
    again = client.post(URL, json=batch, headers=headers)
    assert again.json()["status"] == "duplicate_ignored"


@pytest.mark.parametrize(
    "body, encoding, status",
    [
        (gzip.compress(b"[" + b" " * (MAX_INFLATED + 10) + b"]"), "gzip", 413),
        (b"not gzip at all", "gzip", 400),
        (gzip.compress(b'{"batch_id": "x"}')[:-8], "gzip", 400),
        (b"{}", "br", 415),
    ],
    ids=["gzip-bomb", "corrupt", "truncated", "other-encoding"],
)
def test_bad_compressed_bodies_are_refused_before_parsing(client, body, encoding, status):
    # No credentials needed: the body is refused before the route runs.
    r = client.post(URL, content=body, headers={"Content-Encoding": encoding})
    assert r.status_code == status, r.text
    assert len(body) < 1024 * 1024, "the bomb is small on the wire"


def test_other_routes_are_not_inflated(client):
    r = client.post(
        "/api/v1/auth/edge-lease", content=b"not gzip", headers={"Content-Encoding": "gzip"}
    )
    assert r.status_code == 401, "untouched: the route's own auth answers"
