"""Raw CAN traces from session sync, stored in S3 through an outbox (Task 2.2, A-CEO-2).

Session sync may carry raw CAN frames. They're written as a gzipped candump log
(``(sec.usec) can0 ID#DATA``, the format can-utils, SavvyCAN and cantools read)
into ``can_trace_outbox`` inside the batch's own transaction. After commit the
API uploads the batch's traces; if S3 refuses, the batch has still succeeded and
the row stays pending until ``python -m app.cli drain-can-traces`` uploads it.
The key is fixed when the row is written, so a repeated upload overwrites the
same object.

Uploads stop at the first failure: when S3 is down every call would wait out its
timeout, so trying the rest only delays the response or the drain.
"""

from __future__ import annotations

import gzip
import re
import uuid
from uuid import UUID

from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select, text, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.db.models import CanTraceOutbox
from app.services import object_store

CONTENT_TYPE = "application/gzip"
MAX_FRAMES_PER_BATCH = 200_000


class CanFrameIn(BaseModel):
    """One raw CAN frame from the edge ring buffer (``StoredFrame``)."""

    timestamp_us: int = Field(ge=0)
    can_id: int = Field(ge=0, le=0x1FFFFFFF)
    extended: bool = False
    data: str = Field(pattern=r"^([0-9A-Fa-f]{2}){0,64}$")

    @model_validator(mode="after")
    def _standard_id_fits(self) -> CanFrameIn:
        if not self.extended and self.can_id > 0x7FF:
            raise ValueError("an 11-bit CAN id is at most 0x7FF; set extended for 29-bit ids")
        return self


def candump_log(frames: list[CanFrameIn]) -> bytes:
    """The frames as a candump log in time order, gzipped reproducibly."""
    lines = []
    for f in sorted(frames, key=lambda f: f.timestamp_us):
        can_id = f"{f.can_id:08X}" if f.extended else f"{f.can_id:03X}"
        sec, usec = divmod(f.timestamp_us, 1_000_000)
        lines.append(f"({sec}.{usec:06d}) can0 {can_id}#{f.data.upper()}\n")
    return gzip.compress("".join(lines).encode(), mtime=0)


def queue_trace(
    store: Session,
    tenant_id: UUID,
    batch_id: str,
    session_id: UUID,
    frames: list[CanFrameIn],
) -> None:
    """Adds the batch's trace to the outbox, in the caller's transaction."""
    if not frames:
        return
    store.add(
        CanTraceOutbox(
            tenant_id=tenant_id,
            batch_id=batch_id,
            session_id=session_id,
            s3_key=object_store.object_key("can_traces", tenant_id, uuid.uuid4(), "log.gz"),
            frame_count=len(frames),
            first_timestamp_us=min(f.timestamp_us for f in frames),
            last_timestamp_us=max(f.timestamp_us for f in frames),
            body=candump_log(frames),
        )
    )


def upload_pending(store: Session, *, batch_id: str | None = None, limit: int = 100) -> int:
    """Uploads pending traces visible to this session; returns how many are still pending.

    ``batch_id`` limits it to one batch (right after that batch commits). Rows are
    locked with SKIP LOCKED, so two drains never upload the same row at once.
    """
    query = select(CanTraceOutbox).where(CanTraceOutbox.uploaded_at.is_(None))
    if batch_id is not None:
        query = query.where(CanTraceOutbox.batch_id == batch_id)
    rows = (
        store.execute(
            query.order_by(CanTraceOutbox.id).limit(limit).with_for_update(skip_locked=True)
        )
        .scalars()
        .all()
    )
    for done, row in enumerate(rows):
        try:
            object_store.put(row.s3_key, row.body or b"", CONTENT_TYPE)
        except object_store.StorageError as exc:
            row.attempts += 1
            row.last_error = re.sub(r"\s+", " ", str(exc))[:500]
            return len(rows) - done
        store.execute(
            update(CanTraceOutbox)
            .where(CanTraceOutbox.id == row.id)
            .values(uploaded_at=func.now(), body=None, attempts=CanTraceOutbox.attempts + 1)
        )
    return 0


def drain(owner_engine: Engine, limit: int = 500) -> int:
    """Periodic job (owner role, every tenant): uploads traces S3 refused earlier."""
    with Session(owner_engine) as store, store.begin():
        store.execute(text("SET LOCAL lock_timeout = '5s'"))
        return upload_pending(store, limit=limit)
