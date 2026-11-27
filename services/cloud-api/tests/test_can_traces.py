"""Task 2.2: raw CAN traces from session sync land in S3, through an outbox (A-CEO-2).

Runs against real Postgres and S3 (SeaweedFS locally); skips when either is down.
"""

from __future__ import annotations

import gzip
import json
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app.services import can_traces, object_store
from app.services.can_traces import CanFrameIn, candump_log, mask_vins
from tests.test_security import _auth, _dev_session, _postgres_up

T0_US = 1_790_000_000_000_000
VIN = "WBAVB11060PT00001"
SERIAL = VIN[9:]


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


def _frame(i: int, can_id: int, data: str, extended: bool = False) -> dict:
    """One frame in the shared wire shape (packages/schemas CanFrame)."""
    return {
        "timestamp_us": T0_US + i * 10_000,
        "can_id": can_id,
        "is_extended": extended,
        "dlc": len(data) // 2,
        "data_hex": data,
    }


def _frames(n: int) -> list[dict]:
    return [
        _frame(i, 0x18DAF110 if i % 2 else 0x7E8, f"{i % 256:02X}0102030405", bool(i % 2))
        for i in range(n)
    ]


def _isotp_vin_response(prefix: bytes, vin: str, can_id: int, address: int | None = None):
    """A multi-frame ISO-TP response carrying `prefix + vin` (normal or extended addressing)."""
    payload = prefix + vin.encode()
    head = b"" if address is None else bytes([address])
    room_ff, room_cf = (6, 7) if address is None else (5, 6)
    chunks = [bytes([0x10 | (len(payload) >> 8), len(payload) & 0xFF]) + payload[:room_ff]]
    rest, seq = payload[room_ff:], 1
    while rest:
        chunks.append(bytes([0x20 | (seq & 0x0F)]) + rest[:room_cf])
        rest, seq = rest[room_cf:], seq + 1
    return [
        _frame(100 + i, can_id, (head + c).ljust(8, b"\xaa").hex().upper())
        for i, c in enumerate(chunks)
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


def _bytes_of(frames: list[CanFrameIn]) -> bytes:
    return b"".join(bytes.fromhex(f.data_hex) for f in frames)


# --- format and wire shape ---


def test_candump_log_format():
    log = gzip.decompress(candump_log([CanFrameIn(**f) for f in reversed(_frames(2))])).decode()
    assert log == (
        "(1790000000.000000) can0 7E8#000102030405\n"
        "(1790000000.010000) can0 18DAF110#010102030405\n"
    ), "time order, 3-digit standard ids, 8-digit extended ids"
    assert candump_log([CanFrameIn(**f) for f in _frames(3)]) == candump_log(
        [CanFrameIn(**f) for f in _frames(3)]
    ), "reproducible bytes"


def test_frame_model_matches_the_shared_wire_schema():
    """CanFrameIn takes exactly the CanFrame shape the daemon already sends."""
    path = Path(__file__).resolve().parents[3] / "packages" / "schemas" / "edge_ws.schema.json"
    schema = json.loads(path.read_text())
    defs = schema.get("$defs") or schema["definitions"]
    wire = defs["CanFrame"]
    assert set(CanFrameIn.model_fields) == set(wire["properties"]) == set(wire["required"])
    assert CanFrameIn.model_config.get("extra") == "forbid"
    assert can_traces.MAX_TIMESTAMP_US == defs["TimestampUs"]["maximum"]


# --- VIN masking (Task 2.2: the anonymizer removes VIN serials) ---


@pytest.mark.parametrize(
    "prefix, address",
    [
        (bytes([0x62, 0xF1, 0x90]), None),  # UDS ReadDataByIdentifier F190
        (bytes([0x49, 0x02, 0x01]), None),  # OBD Mode 09 PID 02
        (bytes([0x62, 0xF1, 0x90]), 0xF1),  # BMW D-CAN extended addressing
    ],
    ids=["uds-f190", "obd-0902", "extended-addressing"],
)
def test_vin_serial_is_masked_in_the_frames(prefix, address):
    frames = [CanFrameIn(**f) for f in _isotp_vin_response(prefix, VIN, 0x7E8, address)]
    # Exactly VIN positions 10-17 become '*'; PCI bytes, ids, lengths and the
    # WMI/VDS (positions 1-9) are unchanged.
    expected = [
        CanFrameIn(**f) for f in _isotp_vin_response(prefix, VIN[:9] + "*" * 8, 0x7E8, address)
    ]
    assert mask_vins(frames) == expected
    assert _bytes_of(mask_vins(frames)).count(b"*") == 8


def test_other_traffic_is_left_alone():
    other = _isotp_vin_response(bytes([0x62, 0xF1, 0x8C]), "SERIAL-NUMBER-123", 0x7E8)
    not_a_vin = _isotp_vin_response(bytes([0x62, 0xF1, 0x90]), "not a real vin!!!", 0x7E8)
    frames = [CanFrameIn(**f) for f in other + not_a_vin + _frames(4)]
    assert mask_vins(frames) == frames


# --- storage ---


@needs_infra
def test_gate_sync_stores_raw_can_trace_in_s3_with_vin_masked(client, owner):
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-{uuid.uuid4().hex[:10]}"
    frames = _frames(20) + _isotp_vin_response(bytes([0x62, 0xF1, 0x90]), VIN, 0x7E8)
    batch = _batch(edge_session, frames)
    r = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["can_frames_ingested"] == len(frames) and r.json()["traces_pending"] == 0
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is not None and row.body is None and row.attempts == 1
    assert row.frame_count == len(frames) and row.first_timestamp_us == T0_US
    assert row.s3_key.startswith(f"can_traces/{row.tenant_id}/") and row.s3_key.endswith(".log.gz")
    stored = object_store.get(row.s3_key)
    assert stored == candump_log(mask_vins([CanFrameIn(**f) for f in frames]))
    log = gzip.decompress(stored).decode()
    assert len(log.splitlines()) == len(frames)
    for chunk in (SERIAL[:4], SERIAL[4:]):
        assert chunk.encode().hex().upper() not in log
    again = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert again.json()["status"] == "duplicate_ignored"
    assert len(_rows(owner, edge_session)) == 1


@needs_infra
def test_request_upload_holds_no_lock_and_uses_the_short_timeout_client(client, owner, monkeypatch):
    """While S3 is being called, the outbox row is not locked and no transaction waits on it."""
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-lock-{uuid.uuid4().hex[:10]}"
    real_put, seen = object_store.put, []

    def watching_put(key, data, content_type, **kwargs):
        with owner.connect() as c:
            locked = c.execute(
                text("SELECT id FROM can_trace_outbox WHERE s3_key = :k FOR UPDATE NOWAIT"),
                {"k": key},
            ).all()
            c.rollback()
        seen.append((bool(locked), kwargs.get("fast", False)))
        real_put(key, data, content_type)

    monkeypatch.setattr(object_store, "put", watching_put)
    r = client.post("/api/v1/sessions/sync", json=_batch(edge_session, _frames(3)), headers=headers)
    assert r.status_code == 200, r.text
    assert seen == [(True, True)], "row committed and unlocked during the call; fast client"
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is not None


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
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is None

    monkeypatch.setattr(object_store, "put", real_put)
    can_traces.drain(owner)
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is not None and row.body is None
    assert len(gzip.decompress(object_store.get(row.s3_key)).splitlines()) == 5


@needs_infra
def test_a_failing_row_does_not_block_the_rest(client, owner, monkeypatch):
    """One object S3 keeps refusing is retried, but the traces behind it still upload."""
    headers = _auth(_dev_session(client)["access_token"])
    sessions = [f"sess-can-poison-{uuid.uuid4().hex[:8]}-{i}" for i in range(3)]
    monkeypatch.setattr(
        object_store,
        "put",
        lambda *a, **k: (_ for _ in ()).throw(object_store.StorageError("down")),
    )
    for s in sessions:
        client.post("/api/v1/sessions/sync", json=_batch(s, _frames(2)), headers=headers)
    poison_key = _rows(owner, sessions[0])[0].s3_key
    monkeypatch.undo()
    real_put = object_store.put

    def refuse_one(key, *args, **kwargs):
        if key == poison_key:
            raise object_store.StorageError("AccessDenied for this key (test)")
        real_put(key, *args, **kwargs)

    monkeypatch.setattr(object_store, "put", refuse_one)
    pending = can_traces.drain(owner)
    assert pending >= 1, "the true backlog, not just this page"
    assert _rows(owner, sessions[0])[0].uploaded_at is None
    assert all(_rows(owner, s)[0].uploaded_at is not None for s in sessions[1:])
    monkeypatch.undo()
    can_traces.drain(owner)
    assert _rows(owner, sessions[0])[0].uploaded_at is not None


@needs_infra
def test_drain_stops_after_repeated_failures_and_reports_the_backlog(client, owner, monkeypatch):
    headers = _auth(_dev_session(client)["access_token"])
    calls = []

    def s3_down(key, *args, **kwargs):
        calls.append(key)
        raise object_store.StorageError("S3 unavailable (test)")

    monkeypatch.setattr(object_store, "put", s3_down)
    for _ in range(5):
        edge_session = f"sess-can-many-{uuid.uuid4().hex[:10]}"
        client.post("/api/v1/sessions/sync", json=_batch(edge_session, _frames(2)), headers=headers)
    calls.clear()
    assert can_traces.drain(owner) >= 5
    assert len(calls) == can_traces.MAX_CONSECUTIVE_FAILURES
    monkeypatch.undo()
    assert can_traces.drain(owner, limit=1) >= 4, "a limit of 1 still reports everything left"
    can_traces.drain(owner)


@needs_infra
def test_drain_refuses_keys_outside_the_tenant_prefix(client, owner, monkeypatch):
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-key-{uuid.uuid4().hex[:10]}"
    monkeypatch.setattr(
        object_store,
        "put",
        lambda *a, **k: (_ for _ in ()).throw(object_store.StorageError("down")),
    )
    client.post("/api/v1/sessions/sync", json=_batch(edge_session, _frames(2)), headers=headers)
    monkeypatch.undo()
    (row,) = _rows(owner, edge_session)
    foreign = f"can_traces/{uuid.uuid4()}/{uuid.uuid4()}.log.gz"
    with owner.begin() as c:
        c.execute(
            text("UPDATE can_trace_outbox SET s3_key = :k WHERE id = :i"),
            {"k": foreign, "i": row.id},
        )
    uploaded = []
    monkeypatch.setattr(object_store, "put", lambda key, *a, **k: uploaded.append(key))
    can_traces.drain(owner)
    assert foreign not in uploaded
    (row,) = _rows(owner, edge_session)
    assert row.uploaded_at is None and "tenant" in row.last_error
    with owner.begin() as c:  # leave no unuploadable row behind in the shared dev DB
        c.execute(text("DELETE FROM can_trace_outbox WHERE id = :i"), {"i": row.id})


@needs_infra
def test_drain_cli_exit_codes(client, owner, monkeypatch, capsys):
    from app import cli

    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-cli-{uuid.uuid4().hex[:10]}"
    monkeypatch.setattr(
        object_store,
        "put",
        lambda *a, **k: (_ for _ in ()).throw(object_store.StorageError("down")),
    )
    client.post("/api/v1/sessions/sync", json=_batch(edge_session, _frames(2)), headers=headers)
    capsys.readouterr()
    assert cli.main(["drain-can-traces"]) == 1
    assert json.loads(capsys.readouterr().out)["pending"] >= 1
    monkeypatch.undo()
    assert cli.main(["drain-can-traces"]) == 0
    assert json.loads(capsys.readouterr().out) == {"pending": 0}


# --- validation ---


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
@pytest.mark.parametrize(
    "frame",
    [
        {**_frame(0, 0x800, "00"), "is_extended": False},
        {**_frame(0, 0x7E8, "00"), "data_hex": "XYZ"},
        {**_frame(0, 0x20000000, "00"), "is_extended": True},
        {**_frame(0, 0x7E8, "00"), "data_hex": "00" * 9, "dlc": 9},
        {**_frame(0, 0x7E8, "00"), "timestamp_us": 2**63},
        {"timestamp_us": T0_US, "can_id": 0x7E8, "extended": False, "data": "00"},
        {**_frame(0, 0x7E8, "00"), "channel": "can1"},
    ],
    ids=[
        "11bit-too-big",
        "bad-hex",
        "29bit-too-big",
        "fd-length",
        "timestamp-overflow",
        "old-field-names",
        "unknown-field",
    ],
)
def test_invalid_frames_refuse_the_whole_batch(client, owner, frame):
    headers = _auth(_dev_session(client)["access_token"])
    edge_session = f"sess-can-bad-{uuid.uuid4().hex[:10]}"
    r = client.post("/api/v1/sessions/sync", json=_batch(edge_session, [frame]), headers=headers)
    assert r.status_code == 422
    assert client.get(f"/api/v1/sessions/{edge_session}", headers=headers).status_code == 404


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_watermark_overflow_is_refused_not_a_500(client, owner):
    headers = _auth(_dev_session(client)["access_token"])
    batch = _batch(f"sess-can-wm-{uuid.uuid4().hex[:10]}", [])
    batch["watermark_us"] = 2**63
    assert client.post("/api/v1/sessions/sync", json=batch, headers=headers).status_code == 422


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
