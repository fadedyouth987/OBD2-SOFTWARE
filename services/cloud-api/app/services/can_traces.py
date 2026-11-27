"""Raw CAN traces from session sync, stored in S3 through an outbox (Task 2.2, A-CEO-2).

Session sync may carry raw CAN frames, in the edge's own ``CanFrame`` wire shape
(``packages/schemas/edge_ws.schema.json``). Before anything is stored, VIN
serials are masked (Task 2.2: "the anonymizer removes VIN serials"): ISO-TP
responses to UDS ReadDataByIdentifier F190 and OBD Mode 09 PID 02 are
reassembled, and VIN positions 10-17 are replaced with ``*`` in the frame bytes.
The frames are written as a gzipped candump log (``(sec.usec) can0 ID#DATA``,
the format can-utils, SavvyCAN and cantools read) into ``can_trace_outbox``
inside the batch's own transaction.

After commit the API uploads the trace from memory with the short-timeout S3
client and no transaction or row lock held, then marks the row in a short
transaction. If S3 refuses or hangs, the batch has still succeeded and the row
stays pending for ``python -m app.cli drain-can-traces``. The drain works row by
row in short transactions, retries rows that failed least often first (so one
object S3 keeps refusing can't block the rest), stops after
``MAX_CONSECUTIVE_FAILURES`` failures in a row (S3 is down), and returns the
true backlog. Keys are fixed when the row is written; a repeated upload (two
drains, or a drain racing the request) writes the same bytes to the same key.
"""

from __future__ import annotations

import gzip
import logging
import re
import uuid
from dataclasses import dataclass
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.db.models import CanTraceOutbox
from app.services import object_store

log = logging.getLogger("obd2.can_traces")

CONTENT_TYPE = "application/gzip"
MAX_FRAMES_PER_BATCH = 50_000
MAX_TIMESTAMP_US = 2**53 - 1  # the wire schema's TimestampUs maximum
MAX_CONSECUTIVE_FAILURES = 3
MASK = ord("*")

# ISO-TP response payloads that carry a VIN: UDS 0x62 F190, OBD 0x49 02 <count>.
_VIN_RESPONSE_PREFIXES = (bytes([0x62, 0xF1, 0x90]), bytes([0x49, 0x02, 0x01]))
_VIN_CHARS = frozenset(b"ABCDEFGHJKLMNPRSTUVWXYZ0123456789")


class CanFrameIn(BaseModel):
    """One raw CAN frame, exactly the edge's ``CanFrame`` wire shape."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    timestamp_us: int = Field(ge=0, le=MAX_TIMESTAMP_US)
    can_id: int = Field(ge=0, le=0x1FFFFFFF)
    is_extended: bool
    dlc: int = Field(ge=0, le=8)
    data_hex: str = Field(pattern=r"^([0-9A-Fa-f]{2}){0,8}$")

    @model_validator(mode="after")
    def _standard_id_fits(self) -> CanFrameIn:
        if not self.is_extended and self.can_id > 0x7FF:
            raise ValueError("an 11-bit CAN id is at most 0x7FF; set is_extended for 29-bit ids")
        return self


def _vin_start(payload: bytes) -> int | None:
    for prefix in _VIN_RESPONSE_PREFIXES:
        vin = payload[len(prefix) : len(prefix) + 17]
        if payload.startswith(prefix) and len(vin) == 17 and all(c in _VIN_CHARS for c in vin):
            return len(prefix)
    return None


def mask_vins(frames: list[CanFrameIn]) -> list[CanFrameIn]:
    """The frames with VIN positions 10-17 masked in any VIN-carrying ISO-TP response.

    Tries normal addressing (PCI in byte 0) and extended addressing (target
    address in byte 0, PCI in byte 1, as on BMW D-CAN). Only a complete response
    whose 17 characters are valid VIN characters is touched, so other traffic is
    returned unchanged.
    """
    data = [bytearray.fromhex(f.data_hex) for f in frames]
    order = sorted(range(len(frames)), key=lambda i: (frames[i].timestamp_us, i))
    for offset in (0, 1):
        open_msgs: dict[tuple, dict] = {}
        for i in order:
            d = data[i]
            if len(d) <= offset + 1:
                continue
            key = (frames[i].can_id, frames[i].is_extended, d[0] if offset else None)
            pci = d[offset] >> 4
            if pci == 1:  # first frame
                total = ((d[offset] & 0x0F) << 8) | d[offset + 1]
                if total < 8:
                    open_msgs.pop(key, None)
                    continue
                open_msgs[key] = {
                    "total": total,
                    "sn": 1,
                    "pos": [(i, j) for j in range(offset + 2, len(d))],
                }
            elif pci == 2 and key in open_msgs:  # consecutive frame
                msg = open_msgs[key]
                if d[offset] & 0x0F != msg["sn"] & 0x0F:
                    del open_msgs[key]
                    continue
                msg["sn"] += 1
                msg["pos"] += [(i, j) for j in range(offset + 1, len(d))]
            else:
                continue
            msg = open_msgs.get(key)
            if msg is None or len(msg["pos"]) < msg["total"]:
                continue
            del open_msgs[key]
            pos = msg["pos"][: msg["total"]]
            start = _vin_start(bytes(data[a][b] for a, b in pos))
            if start is not None:
                for a, b in pos[start + 9 : start + 17]:
                    data[a][b] = MASK
    return [
        f
        if bytes(d) == bytes.fromhex(f.data_hex)
        else f.model_copy(update={"data_hex": bytes(d).hex().upper()})
        for f, d in zip(frames, data, strict=True)
    ]


def candump_log(frames: list[CanFrameIn]) -> bytes:
    """The frames as a candump log in time order, gzipped reproducibly."""
    lines = []
    for f in sorted(frames, key=lambda f: f.timestamp_us):
        can_id = f"{f.can_id:08X}" if f.is_extended else f"{f.can_id:03X}"
        sec, usec = divmod(f.timestamp_us, 1_000_000)
        lines.append(f"({sec}.{usec:06d}) can0 {can_id}#{f.data_hex.upper()}\n")
    return gzip.compress("".join(lines).encode(), compresslevel=6, mtime=0)


@dataclass(frozen=True)
class QueuedTrace:
    s3_key: str
    body: bytes


def queue_trace(
    store: Session,
    tenant_id: UUID,
    batch_id: str,
    session_id: UUID,
    frames: list[CanFrameIn],
) -> QueuedTrace | None:
    """Adds the batch's masked trace to the outbox, in the caller's transaction."""
    if not frames:
        return None
    trace = QueuedTrace(
        s3_key=object_store.object_key("can_traces", tenant_id, uuid.uuid4(), "log.gz"),
        body=candump_log(mask_vins(frames)),
    )
    store.add(
        CanTraceOutbox(
            tenant_id=tenant_id,
            batch_id=batch_id,
            session_id=session_id,
            s3_key=trace.s3_key,
            frame_count=len(frames),
            first_timestamp_us=min(f.timestamp_us for f in frames),
            last_timestamp_us=max(f.timestamp_us for f in frames),
            body=trace.body,
        )
    )
    return trace


def mark_uploaded(store: Session, s3_key: str) -> None:
    store.execute(
        update(CanTraceOutbox)
        .where(CanTraceOutbox.s3_key == s3_key, CanTraceOutbox.uploaded_at.is_(None))
        .values(uploaded_at=func.now(), body=None, attempts=CanTraceOutbox.attempts + 1)
    )


def record_failure(store: Session, s3_key: str, error: str) -> None:
    store.execute(
        update(CanTraceOutbox)
        .where(CanTraceOutbox.s3_key == s3_key, CanTraceOutbox.uploaded_at.is_(None))
        .values(
            attempts=CanTraceOutbox.attempts + 1,
            last_error=re.sub(r"\s+", " ", error)[:500],
        )
    )


def _belongs(key: str, tenant_id: UUID) -> bool:
    return key.startswith("can_traces/") and object_store.key_belongs_to(key, tenant_id)


def pending_count(owner_engine: Engine) -> int:
    with Session(owner_engine) as s:
        return s.scalar(
            select(func.count())
            .select_from(CanTraceOutbox)
            .where(CanTraceOutbox.uploaded_at.is_(None))
        )


def drain(owner_engine: Engine, limit: int = 500) -> int:
    """Periodic job (owner role, every tenant). Returns the traces still pending."""
    with Session(owner_engine) as s:
        rows = s.execute(
            select(CanTraceOutbox.id, CanTraceOutbox.tenant_id, CanTraceOutbox.s3_key)
            .where(CanTraceOutbox.uploaded_at.is_(None))
            .order_by(CanTraceOutbox.attempts, CanTraceOutbox.id)
            .limit(limit)
        ).all()
    failures = 0
    for row_id, tenant_id, key in rows:
        if not _belongs(key, tenant_id):
            # Defence in depth: never write outside the row's own tenant prefix.
            with Session(owner_engine) as s, s.begin():
                record_failure(
                    s, key, "key is outside this tenant's can_traces prefix; not uploaded"
                )
            log.error("can trace %s has a key outside its tenant prefix", row_id)
            continue
        with Session(owner_engine) as s:
            body = s.scalar(
                select(CanTraceOutbox.body).where(
                    CanTraceOutbox.id == row_id, CanTraceOutbox.uploaded_at.is_(None)
                )
            )
        if body is None:  # uploaded meanwhile
            continue
        try:
            object_store.put(key, body, CONTENT_TYPE)
        except object_store.StorageError as exc:
            with Session(owner_engine) as s, s.begin():
                record_failure(s, key, str(exc))
            failures += 1
            if failures >= MAX_CONSECUTIVE_FAILURES:
                break
            continue
        failures = 0
        with Session(owner_engine) as s, s.begin():
            mark_uploaded(s, key)
    return pending_count(owner_engine)
