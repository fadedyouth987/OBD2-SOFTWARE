"""Task 2.2: raw CAN traces from session sync land in S3, through an outbox (A-CEO-2).

Runs against real Postgres and S3 (SeaweedFS locally); skips when either is down.
"""

from __future__ import annotations

import gzip
import uuid

import pytest
from sqlalchemy import create_engine, text

from app.services import can_traces, object_store
from app.services.can_traces import CanFrameIn, candump_log
from tests.test_security import _auth, _dev_session, _postgres_up

T0_US = 1_790_000_000_000_000


def _s3_up() -> bool:
    try:
        object_store.put(f"can_traces/probe/{uuid.uuid4()}.txt", b"ok", "text/plain")
        return True
    except object_store.StorageError:
        return False


needs_infra = pytest.mark.skipif(
    not (_postgres_up() and _s3_up()), reason="needs Postgres and S3 (just infra-up)"
)


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture(scope="module")
def owner():
    from app.config import get_settings

    engine = create_engine(get_settings().migration_database_url)
    yield engine
    engine.dispose()


def _frames(n: int) -> list[dict]:
    return [
        {
            "timestamp_us": T0_US + i * 10_000,
            "can_id": 0x18DAF110 if i % 2 else 0x7E8,
            "extended": bool(i % 2),
            "data": f"{i:02X}0102030405",
        }
        for i in range(n)
    ]


def _batch(edge_session: str, frames: list[dict]) -> dict:
    return {
        "batch_id": f"batch-{uuid.uuid4()}",
        "session_id": edge_session,
        "watermark_us": T0_US,
        "telemetry_rows": [{"pid": 12, "value": 800, "name": "rpm"}],
        "can_frames": frames,
    }


def _rows(owner, edge_session: str) -> list:
    with owner.connect() as c:
        return c.execute(
            text(
                "SELECT o.* FROM can_trace_outbox o "
                "JOIN diagnostic_sessions s ON s.id = o.session_id "
                "WHERE s.edge_session_id = :e ORDER BY o.id"
            ),
            {"e": edge_session},
        ).all()


def test_candump_log_format():
    log = gzip.decompress(candump_log([CanFrameIn(**f) for f in reversed(_frames(2))])).decode()
    assert log == (
        "(1790000000.000000) can0 7E8#000102030405\n"
        "(1790000000.010000) can0 18DAF110#010102030405\n"
    ), "time order, 3-digit standard ids, 8-digit extended ids"
    assert candump_log([CanFrameIn(**f) for f in _frames(3)]) == candump_log(
        [CanFrameIn(**f) for f in _frames(3)]
    ), "reproducible bytes"


@needs_infra
def test_gate_sync_stores_raw_can_trace_in_s3(client, owner):
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-{uuid.uuid4().hex[:10]}"
    batch = _batch(edge_session, _frames(25))
    r = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["can_frames_ingested"] == 25 and r.json()["traces_pending"] == 0
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is not None and row.body is None and row.attempts == 1
    assert row.frame_count == 25 and row.first_timestamp_us == T0_US
    assert row.s3_key.startswith(f"can_traces/{row.tenant_id}/") and row.s3_key.endswith(".log.gz")
    stored = object_store.get(row.s3_key)
    assert stored == candump_log([CanFrameIn(**f) for f in batch["can_frames"]])
    assert len(gzip.decompress(stored).splitlines()) == 25
    # The same batch again stores nothing new.
    again = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert again.json()["status"] == "duplicate_ignored"
    assert len(_rows(owner, edge_session)) == 1


@needs_infra
def test_partial_failure_s3_down_trace_waits_in_outbox(client, owner, monkeypatch):
    """S3 fails after commit: the batch is stored and acknowledged, the trace is
    kept in the outbox, and the drain uploads it once S3 is back."""
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-down-{uuid.uuid4().hex[:10]}"
    real_put = object_store.put

    def s3_down(*args, **kwargs):
        raise object_store.StorageError("S3 unavailable (test)")

    monkeypatch.setattr(object_store, "put", s3_down)
    r = client.post("/api/v1/sessions/sync", json=_batch(edge_session, _frames(5)), headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "accepted" and r.json()["traces_pending"] == 1
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is None and row.body is not None
    assert row.attempts == 1 and "unavailable" in row.last_error
    assert can_traces.drain(owner) >= 1, "still down: still pending"

    monkeypatch.setattr(object_store, "put", real_put)
    assert can_traces.drain(owner) == 0
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is not None and row.body is None
    assert len(gzip.decompress(object_store.get(row.s3_key)).splitlines()) == 5


@needs_infra
def test_upload_stops_at_the_first_failure(client, owner, monkeypatch):
    """With S3 down, one failed call is enough: the rest are left for the drain."""
    headers = _auth(_dev_session(client)["access_token"])
    calls = []

    def s3_down(key, *args, **kwargs):
        calls.append(key)
        raise object_store.StorageError("S3 unavailable (test)")

    monkeypatch.setattr(object_store, "put", s3_down)
    for _ in range(3):
        edge_session = f"sess-can-many-{uuid.uuid4().hex[:10]}"
        client.post("/api/v1/sessions/sync", json=_batch(edge_session, _frames(2)), headers=headers)
    calls.clear()
    assert can_traces.drain(owner) >= 3
    assert len(calls) == 1
    monkeypatch.undo()
    assert can_traces.drain(owner) == 0


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
@pytest.mark.parametrize(
    "frame",
    [
        {"timestamp_us": T0_US, "can_id": 0x800, "extended": False, "data": "00"},
        {"timestamp_us": T0_US, "can_id": 0x7E8, "data": "XYZ"},
        {"timestamp_us": T0_US, "can_id": 0x20000000, "extended": True, "data": "00"},
        {"timestamp_us": T0_US, "can_id": 0x7E8, "data": "00" * 65},
    ],
)
def test_invalid_frames_refuse_the_whole_batch(client, owner, frame):
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-bad-{uuid.uuid4().hex[:10]}"
    r = client.post("/api/v1/sessions/sync", json=_batch(edge_session, [frame]), headers=headers)
    assert r.status_code == 422
    assert client.get(f"/api/v1/sessions/{edge_session}", headers=headers).status_code == 404


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_batches_without_frames_are_unchanged(client, owner):
    """The web app's job recorder sends no frames; nothing about its batches changes."""
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-none-{uuid.uuid4().hex[:10]}"
    batch = _batch(edge_session, [])
    del batch["can_frames"]
    r = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert r.status_code == 200 and r.json()["traces_pending"] == 0
    assert r.json()["can_frames_ingested"] == 0
    assert _rows(owner, edge_session) == []
