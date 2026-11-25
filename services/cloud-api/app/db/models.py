"""ORM models mirroring ``alembic/versions/001_init_multi_tenant_rls.py`` (Task 2.1).

The migration is the source of truth for constraints, RLS policies and
grants; these models are how the API reads and writes. Always use them
inside ``app.db.session.tenant_session``.
"""

import enum
import uuid
from datetime import date, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    ARRAY,
    CHAR,
    REAL,
    BigInteger,
    Boolean,
    Date,
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
    FLEET = "FLEET"


class BillingStatus(enum.StrEnum):
    NONE = "none"
    TRIALING = "trialing"
    ACTIVE = "active"
    PAST_DUE = "past_due"
    CANCELED = "canceled"
    UNPAID = "unpaid"
    INCOMPLETE = "incomplete"


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
    aasra_verified_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ai_quota_period_start: Mapped[date] = mapped_column(Date, default=date.today)
    stripe_customer_id: Mapped[str | None] = mapped_column(Text)
    stripe_subscription_id: Mapped[str | None] = mapped_column(Text)
    stripe_subscription_status: Mapped[str] = mapped_column(Text, default="none")
    billing_grace_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    billing_event_created: Mapped[int] = mapped_column(BigInteger, default=0)
    lease_version: Mapped[int] = mapped_column(Integer, default=0)
    immo_entitled: Mapped[bool] = mapped_column(Boolean, default=False)
    trial_used: Mapped[bool] = mapped_column(Boolean, default=False)
    trial_ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    site_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = _created()


class User(Base):
    __tablename__ = "users"
    # A new user is invisible to the SELECT policy until a membership exists,
    # so inserts must not use RETURNING to fetch server defaults.
    __mapper_args__ = {"eager_defaults": False}
    id: Mapped[uuid.UUID] = _uuid_pk()
    email: Mapped[str] = mapped_column(Text, unique=True)
    display_name: Mapped[str | None] = mapped_column(Text)
    password_hash: Mapped[str | None] = mapped_column(Text)
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    # The identity provider's stable id (ID token iss + sub) for OIDC sign-in.
    oidc_issuer: Mapped[str | None] = mapped_column(Text)
    oidc_subject: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class TenantMembership(Base):
    __tablename__ = "tenant_memberships"
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[MembershipRole] = mapped_column(
        Enum(MembershipRole, name="membership_role", create_type=False)
    )
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    created_at: Mapped[datetime] = _created()


class Site(Base):
    """A workshop location (migration 006). Plan caps are enforced by the API."""

    __tablename__ = "sites"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    name: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()


class TenantInvite(Base):
    """An emailed invitation to join a workshop. Only the token's SHA-256 is kept."""

    __tablename__ = "tenant_invites"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    email: Mapped[str] = mapped_column(Text)
    role: Mapped[MembershipRole] = mapped_column(
        Enum(MembershipRole, name="membership_role", create_type=False)
    )
    site_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sites.id"))
    token_hash: Mapped[str] = mapped_column(Text)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = _created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OwnershipTransfer(Base):
    """An Owner's offer to hand the workshop to a member (migration 008)."""

    __tablename__ = "ownership_transfers"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    from_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    to_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = _created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, default="PENDING")
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TeamAuditEvent(Base):
    """Append-only team change log (migration 008)."""

    __tablename__ = "team_audit_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(Text)
    subject_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    subject_email: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)


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
    status: Mapped[str] = mapped_column(Text, default="OPEN")
    vehicle_label: Mapped[str | None] = mapped_column(Text)
    vehicle_profile: Mapped[str | None] = mapped_column(Text)
    vin_hmac: Mapped[str | None] = mapped_column(Text)
    vin_redacted: Mapped[str | None] = mapped_column(Text)
    odometer_km: Mapped[int | None] = mapped_column(Integer)
    adapter_id: Mapped[str | None] = mapped_column(Text)
    adapter_kind: Mapped[str | None] = mapped_column(Text)
    daemon_version: Mapped[str | None] = mapped_column(Text)
    lease_tier: Mapped[str | None] = mapped_column(Text)
    customer_ref: Mapped[str | None] = mapped_column(Text)
    complaint: Mapped[str | None] = mapped_column(Text)
    vehicle_make: Mapped[str | None] = mapped_column(Text)
    vehicle_model: Mapped[str | None] = mapped_column(Text)
    model_year: Mapped[int | None] = mapped_column(Integer)
    dtcs: Mapped[list] = mapped_column(JSONB, default=list)
    alerts: Mapped[list] = mapped_column(JSONB, default=list)
    diagnosis: Mapped[dict | None] = mapped_column(JSONB)
    closeout: Mapped[dict | None] = mapped_column(JSONB)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


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
    vehicle_profile: Mapped[str | None] = mapped_column(Text)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    message_count: Mapped[int | None] = mapped_column(Integer)
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
    vehicle_profile: Mapped[str | None] = mapped_column(Text)
    content_type: Mapped[str | None] = mapped_column(Text)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    sha256: Mapped[str | None] = mapped_column(Text)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    pages_charged: Mapped[int] = mapped_column(Integer, default=0)
    charged_period: Mapped[date | None] = mapped_column(Date)
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


class SyncBatch(Base):
    """Idempotency key for edge session sync (tenant, batch_id)."""

    __tablename__ = "sync_batches"
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    batch_id: Mapped[str] = mapped_column(Text, primary_key=True)
    edge_session_id: Mapped[str] = mapped_column(Text)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("diagnostic_sessions.id"))
    watermark_us: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = _created()


class StripeEvent(Base):
    """Stripe webhook idempotency log, visible only to the affected tenant."""

    __tablename__ = "stripe_events"
    event_id: Mapped[str] = mapped_column(Text, primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    event_type: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = _created()


class TechnicianCredential(Base):
    """Per-technician AASRA paperwork. The tenant flag is never sufficient."""

    __tablename__ = "technician_credentials"
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    aasra_member_id: Mapped[str] = mapped_column(Text)
    vsp_status: Mapped[str] = mapped_column(Text, default="pending")
    national_police_check_dated: Mapped[date | None] = mapped_column(Date)
    repairer_licence_renewed_at: Mapped[date | None] = mapped_column(Date)
    declaration_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accredited_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AccreditationRequest(Base):
    """A workshop's or technician's AASRA details awaiting or past review (migration 009)."""

    __tablename__ = "accreditation_requests"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    kind: Mapped[str] = mapped_column(Text)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    aasra_member_id: Mapped[str] = mapped_column(Text)
    business_abn: Mapped[str | None] = mapped_column(Text)
    national_police_check_dated: Mapped[date | None] = mapped_column(Date)
    repairer_licence_renewed_at: Mapped[date | None] = mapped_column(Date)
    declaration_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text, default="PENDING")
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reminders_sent: Mapped[list[int]] = mapped_column(ARRAY(Integer), default=list)


class AccreditationEvidence(Base):
    __tablename__ = "accreditation_evidence"
    id: Mapped[uuid.UUID] = _uuid_pk()
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accreditation_requests.id"))
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    s3_key: Mapped[str] = mapped_column(Text)
    filename: Mapped[str] = mapped_column(Text)
    content_type: Mapped[str] = mapped_column(Text)
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(Text)
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class AccreditationEvent(Base):
    """Append-only accreditation audit (migration 009)."""

    __tablename__ = "accreditation_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    request_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("accreditation_requests.id"))
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    event: Mapped[str] = mapped_column(Text)
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)


class OwnerAuthorisation(Base):
    """Owner declaration metadata. The VIN itself is stored only as an HMAC."""

    __tablename__ = "owner_authorisations"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    vin_hmac: Mapped[str] = mapped_column(Text)
    declared_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()


class ImmoSession(Base):
    """An immobilizer job and its short-lived lease. No PIN or key columns."""

    __tablename__ = "immo_sessions"
    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    authorisation_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    vin_hmac: Mapped[str] = mapped_column(Text)
    oem: Mapped[str] = mapped_column(Text)
    operation: Mapped[str] = mapped_column(Text)
    device_id: Mapped[str] = mapped_column(Text)
    device_tier: Mapped[str] = mapped_column(Text)
    lease_jti: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(Text)
    token_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ImmoAuditEntry(Base):
    """Five-year security-information audit. Append-only; never stores secrets."""

    __tablename__ = "immo_audit"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tenants.id"))
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    aasra_member_id: Mapped[str | None] = mapped_column(Text)
    vin_hmac: Mapped[str | None] = mapped_column(Text)
    device_id: Mapped[str | None] = mapped_column(Text)
    device_tier: Mapped[str | None] = mapped_column(Text)
    oem: Mapped[str | None] = mapped_column(Text)
    operation: Mapped[str | None] = mapped_column(Text)
    event: Mapped[str] = mapped_column(Text)
    nrc: Mapped[int | None] = mapped_column(SmallInteger)
    detail: Mapped[str] = mapped_column(Text, default="")
    retain_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()


class ProcedureSource(Base):
    """A licensor of OEM procedure data (migration 010). Shared reference data."""

    __tablename__ = "procedure_sources"
    id: Mapped[uuid.UUID] = _uuid_pk()
    key: Mapped[str] = mapped_column(Text, unique=True)
    name: Mapped[str] = mapped_column(Text)
    licence: Mapped[str] = mapped_column(Text)
    licence_url: Mapped[str | None] = mapped_column(Text)
    licensed_until: Mapped[date | None] = mapped_column(Date)
    provider: Mapped[str] = mapped_column(Text, default="import")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ProcedureRecord(Base):
    """One versioned, licensed procedure for a service function (migration 010)."""

    __tablename__ = "procedure_records"
    id: Mapped[uuid.UUID] = _uuid_pk()
    source_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("procedure_sources.id"))
    source_ref: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(Text, default="ACTIVE")
    function_id: Mapped[str] = mapped_column(Text)
    make: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    make_key: Mapped[str] = mapped_column(Text)
    model_key: Mapped[str] = mapped_column(Text)
    year_from: Mapped[int] = mapped_column(Integer)
    year_to: Mapped[int] = mapped_column(Integer)
    engine: Mapped[str | None] = mapped_column(Text)
    module: Mapped[str] = mapped_column(Text)
    procedure: Mapped[dict] = mapped_column(JSONB)
    notes: Mapped[str | None] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(Text)
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    imported_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
