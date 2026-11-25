"""Where service-function procedures come from.

A *procedure* is the exact request sequence for one service function (oil
reset, SAS calibration, ...) on one vehicle. Providers are asked in order and
the first match wins:

1. ``SimulatorProvider``: the edge daemon's virtual vehicles, using the
   simulator's own identifiers (``service_procedures.SIMULATOR_PROCEDURES``).
2. ``LicensedCatalogueProvider``: procedures imported from a licensed source,
   matched on the job's make, model and model year. Each carries its source,
   licence and version.

When neither has one, the function says "no verified procedure on file", and
the technician uses the manufacturer's service information. Nothing is guessed.

Licensed data arrives two ways, both through ``import_document`` and the same
strict checks:

- a platform admin uploads the licensor's JSON (``rootcause.procedures/v1``);
- ``sync_from_provider`` pulls the licensor's feed (``PROCEDURE_PROVIDER_FEED_URL``
  with ``PROCEDURE_PROVIDER_API_KEY`` as a bearer token), which must serve the same
  document format. See docs/dev/oem-procedures.md.

The checks only allow what a service function needs: the extended diagnostic
session, RoutineControl start/stop, or InputOutputControl, then back to the
default session. No SecurityAccess (0x27), no writes, no downloads: a document
that asks for anything else is refused as a whole.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any, Protocol
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import ProcedureRecord, ProcedureSource
from app.db.session import get_engine, owner_engine
from app.observability.metrics import inc
from app.services.vehicle_registry import SERVICE_FUNCTIONS_CATALOG

FORMAT = "rootcause.procedures/v1"
MAX_PROCEDURES = 5000
FUNCTION_IDS = {fn["id"] for fn in SERVICE_FUNCTIONS_CATALOG}
_HEX = re.compile(r"^(?:[0-9A-F]{2})+$")


def norm_key(value: str) -> str:
    """Make/model matching key: case-, space- and punctuation-insensitive."""
    return re.sub(r"[^0-9a-z]+", "", (value or "").casefold())


def _hex(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.replace(" ", "").upper()
    if not _HEX.fullmatch(cleaned):
        raise ValueError(f"{value!r} isn't hex bytes")
    return cleaned


def _can_id(value: int | str) -> int:
    n = int(value, 16) if isinstance(value, str) else int(value)
    if not 0 <= n <= 0x1FFFFFFF:
        raise ValueError("CAN id out of range")
    return n


class ProcedureIn(BaseModel):
    function_id: str
    make: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=120)
    year_from: int = Field(ge=1980, le=2100)
    year_to: int = Field(ge=1980, le=2100)
    engine: str | None = Field(default=None, max_length=120)
    source_ref: str = Field(min_length=1, max_length=120)
    module: str = Field(min_length=1, max_length=40)
    tx_id: int | str
    rx_id: int | str
    service: str
    identifier: str
    enter_session_hex: str = "1003"
    start_hex: str
    stop_hex: str | None = None
    exit_session_hex: str = "1001"
    expected_seconds: int = Field(ge=1, le=600)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("function_id")
    @classmethod
    def _known_function(cls, v: str) -> str:
        if v not in FUNCTION_IDS:
            raise ValueError(f"unknown service function {v!r}")
        return v

    @model_validator(mode="after")
    def _safe(self) -> ProcedureIn:
        if self.year_from > self.year_to:
            raise ValueError("year_from is after year_to")
        self.tx_id = _can_id(self.tx_id)
        self.rx_id = _can_id(self.rx_id)
        ident = _hex(self.identifier.removeprefix("0x").removeprefix("0X"))
        if ident is None or len(ident) != 4:
            raise ValueError("identifier must be a 2-byte id like 0x0501")
        self.identifier = f"0x{ident}"
        enter = _hex(self.enter_session_hex)
        exit_ = _hex(self.exit_session_hex)
        start = _hex(self.start_hex) or ""
        stop = _hex(self.stop_hex)
        if enter != "1003":
            raise ValueError("procedures run in the extended session (enter_session_hex 1003)")
        if exit_ != "1001":
            raise ValueError(
                "procedures must return to the default session (exit_session_hex 1001)"
            )
        if self.service == "RoutineControl":
            if not start.startswith("3101" + ident) or len(start) > 8 + 32:
                raise ValueError("RoutineControl start must be 31 01 <identifier> [≤16 bytes]")
            if stop is not None and not stop.startswith("3102" + ident):
                raise ValueError("RoutineControl stop must be 31 02 <identifier>")
        elif self.service == "InputOutputControlByIdentifier":
            if not start.startswith("2F" + ident + "03") or len(start) > 8 + 32:
                raise ValueError("I/O control start must be 2F <identifier> 03 <state>")
            if stop is not None and stop not in {"1001", "2F" + ident + "00"}:
                raise ValueError("I/O control stop must be 10 01 or 2F <identifier> 00")
        else:
            raise ValueError("service must be RoutineControl or InputOutputControlByIdentifier")
        self.enter_session_hex, self.exit_session_hex = enter, exit_
        self.start_hex, self.stop_hex = start, stop
        return self

    def runnable(self) -> dict[str, Any]:
        """The shape the web app runs (same as the simulator procedures)."""
        return {
            "module": self.module,
            "tx_id": self.tx_id,
            "rx_id": self.rx_id,
            "service": self.service,
            "identifier": self.identifier,
            "enter_session_hex": self.enter_session_hex,
            "start_hex": self.start_hex,
            "stop_hex": self.stop_hex,
            "stop_needs_confirmation": bool(self.stop_hex) and self.service == "RoutineControl",
            "exit_session_hex": self.exit_session_hex,
            "expected_seconds": self.expected_seconds,
        }


class SourceIn(BaseModel):
    key: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    name: str = Field(min_length=1, max_length=200)
    licence: str = Field(min_length=3, max_length=2000)
    licence_url: str | None = Field(default=None, max_length=500)
    licensed_until: date | None = None


class DocumentIn(BaseModel):
    format: str
    source: SourceIn
    # True: procedures from this source that aren't in the document are withdrawn.
    replace: bool = False
    procedures: list[ProcedureIn] = Field(max_length=MAX_PROCEDURES)

    @field_validator("format")
    @classmethod
    def _format(cls, v: str) -> str:
        if v != FORMAT:
            raise ValueError(f"format must be {FORMAT!r}")
        return v


def parse_document(raw: Any) -> DocumentIn:
    try:
        doc = DocumentIn.model_validate(raw)
    except ValidationError as exc:
        errors = [
            {"where": ".".join(str(p) for p in e["loc"]), "problem": e["msg"]}
            for e in exc.errors()[:25]
        ]
        raise HTTPException(
            status_code=422,
            detail={"message": "The procedure file didn't pass the checks", "errors": errors},
        ) from exc
    refs = [p.source_ref for p in doc.procedures]
    dupes = sorted({r for r in refs if refs.count(r) > 1})
    if dupes:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Each procedure needs its own source_ref",
                "errors": [
                    {"where": "procedures", "problem": f"repeated: {', '.join(dupes[:10])}"}
                ],
            },
        )
    return doc


def _sha(p: ProcedureIn) -> str:
    return hashlib.sha256(
        json.dumps(p.model_dump(mode="json"), sort_keys=True).encode()
    ).hexdigest()


def import_document(
    raw: Any, *, imported_by: UUID | None, provider: str = "import"
) -> dict[str, Any]:
    doc = parse_document(raw)
    created = updated = unchanged = withdrawn = 0
    now = datetime.now(UTC)
    with Session(owner_engine()) as session, session.begin():
        source = session.scalars(
            select(ProcedureSource).where(ProcedureSource.key == doc.source.key).with_for_update()
        ).one_or_none()
        if source is None:
            source = ProcedureSource(key=doc.source.key, provider=provider)
            session.add(source)
        source.name = doc.source.name
        source.licence = doc.source.licence
        source.licence_url = doc.source.licence_url
        source.licensed_until = doc.source.licensed_until
        source.provider = provider
        source.updated_at = now
        session.flush()
        active = {
            r.source_ref: r
            for r in session.scalars(
                select(ProcedureRecord).where(
                    ProcedureRecord.source_id == source.id, ProcedureRecord.status == "ACTIVE"
                )
            )
        }
        latest = dict(
            session.execute(
                select(ProcedureRecord.source_ref, func.max(ProcedureRecord.version))
                .where(ProcedureRecord.source_id == source.id)
                .group_by(ProcedureRecord.source_ref)
            ).all()
        )
        seen = set()
        for p in doc.procedures:
            seen.add(p.source_ref)
            digest = _sha(p)
            current = active.get(p.source_ref)
            if current is not None and current.sha256 == digest:
                unchanged += 1
                continue
            if current is not None:
                current.status = "SUPERSEDED"
                session.flush()
                updated += 1
            else:
                created += 1
            session.add(
                ProcedureRecord(
                    source_id=source.id,
                    source_ref=p.source_ref,
                    version=int(latest.get(p.source_ref) or 0) + 1,
                    status="ACTIVE",
                    function_id=p.function_id,
                    make=p.make.strip(),
                    model=p.model.strip(),
                    make_key=norm_key(p.make),
                    model_key=norm_key(p.model),
                    year_from=p.year_from,
                    year_to=p.year_to,
                    engine=p.engine,
                    module=p.module,
                    procedure=p.runnable(),
                    notes=p.notes,
                    sha256=digest,
                    imported_by=imported_by,
                )
            )
        if doc.replace:
            for ref, row in active.items():
                if ref not in seen:
                    row.status = "WITHDRAWN"
                    withdrawn += 1
        key = source.key
    inc("procedures_imported", created + updated)
    return {
        "source": key,
        "created": created,
        "updated": updated,
        "unchanged": unchanged,
        "withdrawn": withdrawn,
    }


def withdraw(record_id: UUID) -> dict[str, Any]:
    with Session(owner_engine()) as session, session.begin():
        row = session.get(ProcedureRecord, record_id)
        if row is None or row.status != "ACTIVE":
            raise HTTPException(status_code=404, detail="No active procedure with that id")
        row.status = "WITHDRAWN"
    return {"id": str(record_id), "status": "WITHDRAWN"}


def sync_from_provider(*, imported_by: UUID | None, client=None) -> dict[str, Any]:
    """Pull the licensed feed and import it with replace semantics."""
    import httpx

    s = get_settings()
    if not s.procedure_provider_feed_url or not s.procedure_provider_api_key:
        raise HTTPException(
            status_code=409,
            detail="No licensed procedure feed is configured on this server",
        )
    if not s.procedure_provider_feed_url.startswith("https://"):
        raise HTTPException(status_code=409, detail="The procedure feed must use https")
    http = client or httpx.Client(timeout=30)
    try:
        resp = http.get(
            s.procedure_provider_feed_url,
            headers={
                "Authorization": f"Bearer {s.procedure_provider_api_key}",
                "Accept": "application/json",
            },
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail="The procedure feed didn't respond") from exc
    finally:
        if client is None:
            http.close()
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502, detail=f"The procedure feed answered HTTP {resp.status_code}"
        )
    try:
        raw = resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="The procedure feed didn't send JSON") from exc
    if isinstance(raw, dict):
        raw.setdefault("replace", True)
    result = import_document(raw, imported_by=imported_by, provider="feed")
    return {**result, "feed": s.procedure_provider_name or "licensed feed"}


def catalogue() -> dict[str, Any]:
    with Session(owner_engine()) as session:
        sources = session.scalars(select(ProcedureSource).order_by(ProcedureSource.name)).all()
        counts = dict(
            session.execute(
                select(ProcedureRecord.source_id, func.count())
                .where(ProcedureRecord.status == "ACTIVE")
                .group_by(ProcedureRecord.source_id)
            ).all()
        )
        recent = session.scalars(
            select(ProcedureRecord).order_by(ProcedureRecord.imported_at.desc()).limit(50)
        ).all()
        names = {src.id: src.name for src in sources}
        s = get_settings()
        return {
            "feed_configured": bool(s.procedure_provider_feed_url and s.procedure_provider_api_key),
            "feed_name": s.procedure_provider_name or None,
            "sources": [
                {
                    "id": str(src.id),
                    "key": src.key,
                    "name": src.name,
                    "licence": src.licence,
                    "licence_url": src.licence_url,
                    "licensed_until": src.licensed_until.isoformat()
                    if src.licensed_until
                    else None,
                    "provider": src.provider,
                    "active_procedures": int(counts.get(src.id, 0)),
                    "updated_at": src.updated_at.isoformat() if src.updated_at else None,
                }
                for src in sources
            ],
            "recent": [_record_json(r, names.get(r.source_id)) for r in recent],
        }


def _record_json(r: ProcedureRecord, source_name: str | None) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "source": source_name,
        "source_ref": r.source_ref,
        "version": r.version,
        "status": r.status,
        "function_id": r.function_id,
        "make": r.make,
        "model": r.model,
        "years": f"{r.year_from}–{r.year_to}" if r.year_from != r.year_to else str(r.year_from),
        "module": r.module,
        "imported_at": r.imported_at.isoformat() if r.imported_at else None,
    }


# --- lookup -----------------------------------------------------------------------


@dataclass(frozen=True)
class Vehicle:
    make: str
    model: str
    year: int | None


@dataclass(frozen=True)
class Match:
    procedure: dict[str, Any]
    availability: str  # "simulated" | "licensed"
    source: dict[str, Any] | None = None


class ProcedureProvider(Protocol):
    key: str

    def lookup(self, *, adapter_id: str | None, vehicle: Vehicle | None) -> dict[str, Match]: ...


class SimulatorProvider:
    key = "simulator"

    def lookup(self, *, adapter_id: str | None, vehicle: Vehicle | None) -> dict[str, Match]:
        from app.services.service_procedures import SIMULATOR_PROCEDURES, simulator_profile

        profile = simulator_profile(adapter_id)
        return {
            fn: Match(procedure=proc, availability="simulated")
            for fn, proc in SIMULATOR_PROCEDURES.get(profile or "", {}).items()
        }


class LicensedCatalogueProvider:
    key = "licensed"

    def lookup(self, *, adapter_id: str | None, vehicle: Vehicle | None) -> dict[str, Match]:
        if vehicle is None or vehicle.year is None or not vehicle.make or not vehicle.model:
            return {}
        today = date.today()
        with Session(get_engine()) as session:
            rows = session.execute(
                select(ProcedureRecord, ProcedureSource)
                .join(ProcedureSource, ProcedureSource.id == ProcedureRecord.source_id)
                .where(
                    ProcedureRecord.status == "ACTIVE",
                    ProcedureRecord.make_key == norm_key(vehicle.make),
                    ProcedureRecord.model_key == norm_key(vehicle.model),
                    ProcedureRecord.year_from <= vehicle.year,
                    ProcedureRecord.year_to >= vehicle.year,
                )
                .order_by(ProcedureRecord.imported_at.desc())
            ).all()
            out: dict[str, Match] = {}
            for rec, src in rows:
                if src.licensed_until is not None and src.licensed_until < today:
                    continue
                if rec.function_id in out:
                    continue
                out[rec.function_id] = Match(
                    procedure=dict(rec.procedure),
                    availability="licensed",
                    source={
                        "name": src.name,
                        "licence": src.licence,
                        "licence_url": src.licence_url,
                        "source_ref": rec.source_ref,
                        "version": rec.version,
                        "record_id": str(rec.id),
                        "imported_at": rec.imported_at.isoformat() if rec.imported_at else None,
                        "notes": rec.notes,
                    },
                )
            return out


PROVIDERS: tuple[ProcedureProvider, ...] = (SimulatorProvider(), LicensedCatalogueProvider())


def active_catalogue_size() -> int:
    with Session(get_engine()) as session:
        return int(
            session.scalar(
                select(func.count())
                .select_from(ProcedureRecord)
                .where(ProcedureRecord.status == "ACTIVE")
            )
            or 0
        )
