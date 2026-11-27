"""A-CEO-2: re-sent records in a new batch are stored once, never a dead end.

When the edge loses an acknowledgement it re-reads its unsynced rows and sends
them again, possibly under a new ``batch_id`` and alongside newer rows. The
audit log has one row per (tenant, edge session, seq), so a re-sent audit
record must be skipped, not fail the whole batch: a 409 here is permanent, so
that session would never sync again.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, text

from tests.test_security import _auth, _dev_session, _postgres_up


def _audit_seqs(edge_session: str) -> list[int]:
    from app.config import get_settings

    engine = create_engine(get_settings().migration_database_url)
    try:
        with engine.connect() as c:
            return list(
                c.execute(
                    text("SELECT seq FROM audit_log WHERE edge_session_id = :s ORDER BY seq"),
                    {"s": edge_session},
                ).scalars()
            )
    finally:
        engine.dispose()


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_resent_audit_records_in_a_new_batch_are_stored_once(client):
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-resend-{uuid.uuid4().hex[:10]}"

    def batch(watermark: int, seqs: list[int]) -> dict:
        return {
            "batch_id": f"batch-{uuid.uuid4()}",
            "session_id": edge_session,
            "watermark_us": watermark,
            "telemetry_rows": [{"pid": 12, "value": 800, "name": "rpm"}],
            "audit_entries": [{"seq": n, "action": "0x14", "status": "APPROVED"} for n in seqs],
        }

    first = client.post("/api/v1/sessions/sync", json=batch(1000, [1]), headers=headers)
    assert first.status_code == 200, first.text
    # The ack was lost: seq 1 comes again, with the newer seq 2, in a new batch.
    resend = client.post("/api/v1/sessions/sync", json=batch(2000, [1, 2]), headers=headers)
    assert resend.status_code == 200, resend.text
    assert resend.json()["status"] == "accepted"
    assert resend.json()["audit_ingested"] == 1, "only the new record counts as ingested"
    assert _audit_seqs(edge_session) == [1, 2]
    got = client.get(f"/api/v1/sessions/{edge_session}", headers=headers).json()
    assert got["watermark_us"] == 2000, "the session keeps moving forward"


def _post(client, headers, edge_session: str, entries: list[dict], telemetry: bool = True):
    return client.post(
        "/api/v1/sessions/sync",
        json={
            "batch_id": f"batch-{uuid.uuid4()}",
            "session_id": edge_session,
            "watermark_us": 1000,
            "telemetry_rows": [{"pid": 12, "value": 800, "name": "rpm"}] if telemetry else [],
            "audit_entries": entries,
        },
        headers=headers,
    )


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
@pytest.mark.parametrize(
    "entry",
    [
        {"action": "0x2F", "status": "APPROVED", "detail": "no seq"},
        {"seq": "abc", "action": "0x2F", "status": "APPROVED"},
        {"seq": None, "action": "0x2F", "status": "APPROVED"},
        {"seq": 1.5, "action": "0x2F", "status": "APPROVED"},
    ],
    ids=["missing", "text", "null", "fraction"],
)
def test_audit_entries_need_an_integer_seq(client, entry):
    """No seq means no identity: refuse it instead of guessing one that collides."""
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-noseq-{uuid.uuid4().hex[:10]}"
    r = _post(client, headers, edge_session, [entry])
    assert r.status_code == 422, r.text
    assert _audit_seqs(edge_session) == []
    assert client.get(f"/api/v1/sessions/{edge_session}", headers=headers).status_code == 404


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_a_different_record_on_a_used_seq_is_a_conflict_not_a_silent_drop(client):
    """Only an exact replay is skipped. A different gated-command record that reuses
    a seq is refused loudly and the whole batch is kept out, so nothing is lost."""
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-clash-{uuid.uuid4().hex[:10]}"
    first = {
        "seq": 1,
        "at": "2026-11-26T10:00:00Z",
        "action": "0x2F",
        "status": "APPROVED",
        "detail": "first gated action",
    }
    assert _post(client, headers, edge_session, [first]).status_code == 200
    clash = {**first, "detail": "a different gated action"}
    newer = {**first, "seq": 2, "detail": "newer action"}
    r = _post(client, headers, edge_session, [clash, newer])
    assert r.status_code == 409, r.text
    assert "seq" in r.text and "1" in r.text
    assert _audit_seqs(edge_session) == [1], "nothing from the refused batch was kept"
    # A clash inside one batch is caught the same way.
    other = f"sess-clash-{uuid.uuid4().hex[:10]}"
    r = _post(client, headers, other, [first, clash])
    assert r.status_code == 409
    assert _audit_seqs(other) == []


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_replay_without_at_still_counts_as_the_same_record(client):
    """`at` defaults to the server clock when absent, so it can't decide sameness."""
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-noat-{uuid.uuid4().hex[:10]}"
    entry = {"seq": 7, "action": "0x2F", "status": "APPROVED", "detail": "x"}
    assert _post(client, headers, edge_session, [entry]).status_code == 200
    again = _post(client, headers, edge_session, [entry])
    assert again.status_code == 200 and again.json()["audit_ingested"] == 0
    assert _audit_seqs(edge_session) == [7]


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)
