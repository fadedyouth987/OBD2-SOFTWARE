"""ORM models mirroring ``alembic/versions/001_init_multi_tenant_rls.py`` (Task 2.1).

The migration is the source of truth for constraints, RLS policies and
grants; these models are how the API reads and writes. Always use them
inside ``app.db.session.tenant_session``.
"""

import enum
import uuid
from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    ARRAY,
    CHAR,
    REAL,
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    SmallInteger,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

EMBEDDING_DIM = 384


class Base(DeclarativeBase):
    pass


class MembershipRole(enum.StrEnum):
    OWNER = "OWNER"
    LEAD_TECH = "LEAD_TECH"
    TECH = "TECH"


class SubscriptionTier(enum.StrEnum):
    COMMUNITY = "COMMUNITY"
    PRO = "PRO"
    WORKSHOP = "WORKSHOP"


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text)
    subscription_tier: Mapped[SubscriptionTier] = mapped_column(
        Enum(SubscriptionTier, name="subscription_tier", create_type=False),
        default=SubscriptionTier.COMMUNITY,
    )
    ai_diagnoses_used: Mapped[int] = mapped_column(Integer, default=0)
    schematic_pages_used: Mapped[int] = mapped_column(Integer, default=0)
    aasra_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = _created()


class User(Base):
    __tablename__ = "users"
    # A new user is invisible to the SELECT policy until a membership exists,
    # so inserts must not use RETURNING to fetch server defaults.
    __mapper_args__ = {"eager_defaults": False}
    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(Text, unique=True)
    display_name: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class TenantMembership(Base):
    __tablename__ = "tenant_memberships"
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[MembershipRole] = mapped_column(
        Enum(MembershipRole, name="membership_role", create_type=False)
    )
    created_at: Mapped[datetime] = _created()


class Vehicle(Base):
    __tablename__ = "vehicles"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    vin_hmac: Mapped[str] = mapped_column(Text)
    wmi_vds: Mapped[str | None] = mapped_column(Text)
    make: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(SmallInteger)
    created_at: Mapped[datetime] = _created()


class DiagnosticSession(Base):
    __tablename__ = "diagnostic_sessions"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    vehicle_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    edge_session_id: Mapped[str | None] = mapped_column(Text)
    protocol: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)


class TelemetrySample(Base):
    """Telemetry through the tenant-filtered ``telemetry`` view over the
    compressed ``telemetry_samples`` hypertable (the app role cannot touch the
    hypertable directly). No primary key in the database; the ORM identity is
    the composite below."""

    __tablename__ = "telemetry"
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    pid: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    name: Mapped[str] = mapped_column(Text)
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(Text, default="")


class ResolvedCase(Base):
    __tablename__ = "resolved_cases"
    id: Mapped[uuid.UUID] = _uuid_pk()
    wmi_vds: Mapped[str | None] = mapped_column(Text)
    engine_family: Mapped[str | None] = mapped_column(Text)
    dtcs: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    canonical_summary: Mapped[str] = mapped_column(Text)
    fix_description: Mapped[str] = mapped_column(Text)
    feature_vector: Mapped[list[float] | None] = mapped_column(ARRAY(REAL))
    embedding = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    embedding_model: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class CustomDbcFile(Base):
    __tablename__ = "custom_dbc_files"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    name: Mapped[str] = mapped_column(Text)
    s3_key: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = _created()


class WiringSchematic(Base):
    __tablename__ = "wiring_schematics"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    vehicle_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    title: Mapped[str] = mapped_column(Text)
    s3_key: Mapped[str] = mapped_column(Text)
    page_count: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, default="UPLOADED")
    created_at: Mapped[datetime] = _created()


class AuditLogEntry(Base):
    """Gated-command audit synced from the edge daemon (A-CEO-4). Append-only."""

    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    edge_session_id: Mapped[str] = mapped_column(Text)
    seq: Mapped[int] = mapped_column(BigInteger)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    user_ref: Mapped[str | None] = mapped_column(Text)
    vehicle_ref: Mapped[str | None] = mapped_column(Text)
    ecu: Mapped[str] = mapped_column(Text)
    service: Mapped[str] = mapped_column(Text)
    tier: Mapped[str | None] = mapped_column(CHAR(1))
    outcome: Mapped[str] = mapped_column(Text)
    code: Mapped[str | None] = mapped_column(Text)
    nrc: Mapped[int | None] = mapped_column(SmallInteger)
    detail: Mapped[str] = mapped_column(Text, default="")
    received_at: Mapped[datetime] = _created()
