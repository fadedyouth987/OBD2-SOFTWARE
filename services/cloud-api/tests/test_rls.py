"""Task 2.1 verification gate (and A-ENG-5, A-ENG-9, A-CEO-4), against real Postgres.

A throwaway database is created and migrated as the owner role; every check
then runs as the non-owner ``diag_app`` role the API uses. Without a
reachable Postgres these tests are skipped with "needs Postgres", never passed.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.exc import DBAPIError, OperationalError

from alembic import command
from app.config import get_settings
from app.db.models import (
    AuditLogEntry,
    CustomDbcFile,
    DiagnosticSession,
    ImmoAuditEntry,
    OwnerAuthorisation,
    ResolvedCase,
    TechnicianCredential,
    TelemetrySample,
    Tenant,
    TenantMembership,
    User,
    Vehicle,
    WiringSchematic,
)
from app.db.session import tenant_session
from app.db.vin import vin_hmac, wmi_vds

KEY = b"test-only-vin-hmac-key-0123456789"
APP_PASSWORD = os.environ.get("APP_DB_PASSWORD", "diag_app")


@pytest.fixture(scope="module")
def db():
    """(owner engine, app engine) on a fresh, migrated database."""
    owner_url = make_url(get_settings().migration_database_url)
    admin = create_engine(owner_url, isolation_level="AUTOCOMMIT")
    try:
        with admin.connect() as c:
            c.execute(text("SELECT 1"))
    except OperationalError:
        pytest.skip("needs Postgres (run `just infra-up`); see docs/dev/no-docker.md")
    name = f"diag_test_{uuid.uuid4().hex[:10]}"
    with admin.connect() as c:
        c.execute(text(f'CREATE DATABASE "{name}"'))
    test_owner_url = owner_url.set(database=name)
    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.attributes["url"] = test_owner_url.render_as_string(hide_password=False)
    command.upgrade(cfg, "head")
    owner = create_engine(test_owner_url)
    app = create_engine(
        test_owner_url.set(username="diag_app", password=APP_PASSWORD),
        pool_size=1,
        max_overflow=0,
    )
    yield owner, app
    app.dispose()
    command.downgrade(cfg, "base")  # the migration reverses cleanly
    owner.dispose()
    with admin.connect() as c:
        c.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
    admin.dispose()


def new_tenant(app: Engine, name: str) -> uuid.UUID:
    tid = uuid.uuid4()
    with tenant_session(tid, app) as s:
        s.add(Tenant(id=tid, name=name))
    return tid


def add_vehicle(app: Engine, tid: uuid.UUID, vin: str) -> uuid.UUID:
    vid = uuid.uuid4()
    with tenant_session(tid, app) as s:
        s.add(Vehicle(id=vid, tenant_id=tid, vin_hmac=vin_hmac(vin, KEY), wmi_vds=wmi_vds(vin)))
    return vid


def count(app: Engine, tid: uuid.UUID | None, model) -> int:
    if tid is None:
        with app.connect() as c:
            return c.execute(text(f"SELECT count(*) FROM {model.__tablename__}")).scalar_one()
    with tenant_session(tid, app) as s:
        return s.query(model).count()


def test_gate_tenant_a_vehicle_invisible_to_tenant_b(db):
    _, app = db
    a, b = new_tenant(app, "Workshop A"), new_tenant(app, "Workshop B")
    add_vehicle(app, a, "WBAVB11060PT00001")
    assert count(app, a, Vehicle) == 1
    assert count(app, b, Vehicle) == 0


def test_pooled_connection_reused_across_tenants_leaks_nothing(db):
    """A-ENG-5: one pooled connection, two tenants, nothing carried over."""
    _, app = db
    a, b = new_tenant(app, "Pool A"), new_tenant(app, "Pool B")
    add_vehicle(app, a, "6FPAAAJGSW8B12345")
    with tenant_session(a, app) as s:
        pid_a = s.execute(text("SELECT pg_backend_pid()")).scalar_one()
        seen_a = s.query(Vehicle).filter(Vehicle.tenant_id == a).count()
    with tenant_session(b, app) as s:
        pid_b = s.execute(text("SELECT pg_backend_pid()")).scalar_one()
        assert s.query(Vehicle).count() == 0
        assert s.execute(text("SELECT app_current_tenant()")).scalar_one() == b
    assert pid_a == pid_b, "same physical connection"
    assert seen_a == 1
    # After the transaction the setting is gone: a bare query sees nothing.
    with app.connect() as c:
        assert c.execute(text("SELECT pg_backend_pid()")).scalar_one() == pid_a
        assert c.execute(text("SELECT app_current_tenant()")).scalar_one() is None
        assert c.execute(text("SELECT count(*) FROM vehicles")).scalar_one() == 0


def test_no_tenant_fails_closed_and_cross_tenant_writes_are_refused(db):
    _, app = db
    a, b = new_tenant(app, "Closed A"), new_tenant(app, "Closed B")
    with pytest.raises(DBAPIError, match="row-level security"):
        with app.begin() as c:
            c.execute(
                text("INSERT INTO vehicles (tenant_id, vin_hmac) VALUES (:t, :h)"),
                {"t": a, "h": "0" * 64},
            )
    with pytest.raises(DBAPIError, match="row-level security"):
        with tenant_session(b, app) as s:
            s.add(Vehicle(tenant_id=a, vin_hmac=vin_hmac("1HGCM82633A004352", KEY)))
    # A tenant cannot see or rename another tenant.
    with tenant_session(b, app) as s:
        assert {t.id for t in s.query(Tenant)} == {b}


def _rows_for(tid: uuid.UUID, user_id: uuid.UUID, session_id: uuid.UUID) -> list:
    now = datetime.now(UTC)
    return [
        TenantMembership(tenant_id=tid, user_id=user_id, role="TECH"),
        CustomDbcFile(tenant_id=tid, name="body.dbc", s3_key=f"{tid}/body.dbc", sha256="a" * 64),
        WiringSchematic(tenant_id=tid, title="E90 DME", s3_key=f"{tid}/dme.pdf", page_count=12),
        AuditLogEntry(
            tenant_id=tid,
            edge_session_id="sess_1",
            seq=0,
            at=now,
            ecu="UDS 0x7E0/0x7E8",
            service="0x2F InputOutputControlByIdentifier",
            tier="A",
            outcome="refused",
            code="SAFETY_BLOCKED",
        ),
        TelemetrySample(
            time=now,
            tenant_id=tid,
            session_id=session_id,
            pid=12,
            name="Engine speed",
            value=800.0,
            unit="rpm",
        ),
    ]


def test_every_tenant_table_is_isolated(db):
    _, app = db
    a, b = new_tenant(app, "Iso A"), new_tenant(app, "Iso B")
    user = uuid.uuid4()
    with tenant_session(a, app) as s:
        s.add(User(id=user, email=f"{user}@example.com"))
    session_id = uuid.uuid4()
    with tenant_session(a, app) as s:
        s.add(DiagnosticSession(id=session_id, tenant_id=a, edge_session_id="sess_1"))
    with tenant_session(a, app) as s:
        s.add_all(_rows_for(a, user, session_id))
    for model in [
        TenantMembership,
        DiagnosticSession,
        CustomDbcFile,
        WiringSchematic,
        AuditLogEntry,
        TelemetrySample,
        User,
    ]:
        assert count(app, a, model) >= 1, model.__tablename__
        assert count(app, b, model) == 0, f"{model.__tablename__} leaked to tenant B"
        assert count(app, None, model) == 0, f"{model.__tablename__} visible with no tenant"


def test_app_role_is_unprivileged_and_rls_is_forced(db):
    owner, app = db
    with owner.connect() as c:
        role = c.execute(
            text("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'diag_app'")
        ).one()
        assert tuple(role) == (False, False)
        forced = dict(
            c.execute(
                text(
                    "SELECT relname, relforcerowsecurity AND relrowsecurity FROM pg_class "
                    "WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace "
                    "AND relname NOT IN ('alembic_version', 'tier_retention', 'telemetry_samples')"
                )
            ).all()
        )
        assert forced and all(forced.values()), forced
        owners = (
            c.execute(text("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'"))
            .scalars()
            .all()
        )
        assert "diag_app" not in owners
    # The compressed hypertable is reachable only through the filtered view.
    with pytest.raises(DBAPIError, match="permission denied"):
        with app.connect() as c:
            c.execute(text("SELECT count(*) FROM telemetry_samples"))


def test_telemetry_view_rejects_other_tenants_rows(db):
    _, app = db
    a, b = new_tenant(app, "Tel A"), new_tenant(app, "Tel B")
    with pytest.raises(DBAPIError, match="check option"):
        with tenant_session(b, app) as s:
            s.add(
                TelemetrySample(
                    time=datetime.now(UTC),
                    tenant_id=a,
                    session_id=uuid.uuid4(),
                    pid=13,
                    name="Vehicle speed",
                    value=0.0,
                )
            )


def test_users_visible_only_to_their_tenants(db):
    _, app = db
    a, b = new_tenant(app, "Users A"), new_tenant(app, "Users B")
    alice = uuid.uuid4()
    with tenant_session(a, app) as s:
        s.add(User(id=alice, email="alice@example.com"))
    with tenant_session(a, app) as s:
        s.add(TenantMembership(tenant_id=a, user_id=alice, role="OWNER"))
    with tenant_session(a, app) as s:
        assert s.get(User, alice) is not None
    with tenant_session(b, app) as s:
        assert s.get(User, alice) is None


def test_resolved_cases_vector_search(db):
    owner, app = db
    a, b = new_tenant(app, "Cases A"), new_tenant(app, "Cases B")

    def vec(hot: int) -> list[float]:
        v = [0.0] * 384
        v[hot] = 1.0
        v[(hot + 1) % 384] = 0.2
        return v

    with tenant_session(a, app) as s:
        for i, hot in enumerate([0, 50, 200]):
            s.add(
                ResolvedCase(
                    wmi_vds="WBAVB1106",
                    dtcs=["P0171"],
                    canonical_summary=f"case {i}",
                    fix_description="replaced intake boot",
                    embedding=vec(hot),
                    embedding_model="sentence-transformers/all-MiniLM-L6-v2",
                )
            )
    query = vec(50)
    with tenant_session(b, app) as s:  # shared corpus: another tenant searches it
        top = (
            s.query(ResolvedCase)
            .order_by(ResolvedCase.embedding.cosine_distance(query))
            .limit(2)
            .all()
        )
        assert top[0].canonical_summary == "case 1"
    assert count(app, None, ResolvedCase) == 0, "unauthenticated sessions see no cases"
    with owner.connect() as c:
        idx = c.execute(
            text(
                "SELECT indexdef FROM pg_indexes WHERE indexname = 'resolved_cases_embedding_hnsw'"
            )
        ).scalar_one()
        assert "hnsw" in idx and "vector_cosine_ops" in idx
    with pytest.raises(DBAPIError, match="permission denied"):
        with tenant_session(a, app) as s:
            s.execute(text("DELETE FROM resolved_cases"))


def test_telemetry_compression_policy_and_retention_by_tier(db):
    """A-ENG-9: compression after 7 days; retention by the tenant's tier."""
    owner, app = db
    free, pro = new_tenant(app, "Free"), new_tenant(app, "Pro")
    with owner.begin() as c:
        c.execute(text("UPDATE tenants SET subscription_tier = 'PRO' WHERE id = :t"), {"t": pro})
    now = datetime.now(UTC)
    sid = uuid.uuid4()
    for tid in (free, pro):
        with tenant_session(tid, app) as s:
            for age in (40, 10):
                s.add(
                    TelemetrySample(
                        time=now - timedelta(days=age),
                        tenant_id=tid,
                        session_id=sid,
                        pid=12,
                        name="Engine speed",
                        value=float(age),
                    )
                )
    with owner.connect() as c:
        policy = c.execute(
            text(
                "SELECT config->>'compress_after' FROM timescaledb_information.jobs "
                "WHERE proc_name = 'policy_compression' AND hypertable_name = 'telemetry_samples'"
            )
        ).scalar_one()
        assert policy == "7 days"
    with owner.begin() as c:
        c.execute(text("CALL prune_telemetry_by_tier()"))
    with tenant_session(free, app) as s:
        assert sorted(r.value for r in s.query(TelemetrySample)) == [10.0], (
            "COMMUNITY keeps 30 days"
        )
    with tenant_session(pro, app) as s:
        assert sorted(r.value for r in s.query(TelemetrySample)) == [10.0, 40.0], (
            "PRO keeps 365 days"
        )


def test_audit_log_one_row_per_attempt(db):
    """A-CEO-4: re-syncing the same record adds nothing; the log is append-only."""
    _, app = db
    t = new_tenant(app, "Audit")
    stmt = text(
        "INSERT INTO audit_log (tenant_id, edge_session_id, seq, at, ecu, service, outcome) "
        "VALUES (:t, 'sess_x', :seq, now(), 'UDS 0x7E0/0x7E8', '0x27 SecurityAccess', 'allowed') "
        "ON CONFLICT (tenant_id, edge_session_id, seq) DO NOTHING"
    )
    for _ in range(2):  # the daemon retries a sync
        with tenant_session(t, app) as s:
            for seq in range(3):
                s.execute(stmt, {"t": t, "seq": seq})
    assert count(app, t, AuditLogEntry) == 3
    for sql in ("UPDATE audit_log SET outcome = 'refused'", "DELETE FROM audit_log"):
        with pytest.raises(DBAPIError, match="permission denied"):
            with tenant_session(t, app) as s:
                s.execute(text(sql))


def test_immo_tables_are_tenant_isolated_and_audit_is_append_only(db):
    owner, app = db
    a, b = new_tenant(app, "Immo A"), new_tenant(app, "Immo B")
    uid = uuid.uuid4()
    with tenant_session(a, app) as s:
        s.add(User(id=uid, email=f"tech-{uid.hex[:8]}@localhost"))
        s.flush()
        from app.db.models import MembershipRole, TenantMembership

        s.add(TenantMembership(tenant_id=a, user_id=uid, role=MembershipRole.TECH))
        s.add(
            TechnicianCredential(
                tenant_id=a,
                user_id=uid,
                aasra_member_id="VSP-A",
                national_police_check_dated=__import__("datetime").date.today(),
            )
        )
        auth = OwnerAuthorisation(tenant_id=a, user_id=uid, vin_hmac="ab" * 32)
        s.add(auth)
        s.flush()
        s.add(
            ImmoAuditEntry(
                tenant_id=a,
                event="issued",
                detail="no secret",
                retain_until=__import__("datetime").datetime.now(__import__("datetime").UTC)
                + __import__("datetime").timedelta(days=365 * 5),
            )
        )
    assert count(app, a, TechnicianCredential) == 1
    assert count(app, b, TechnicianCredential) == 0
    assert count(app, a, OwnerAuthorisation) == 1
    assert count(app, b, OwnerAuthorisation) == 0
    assert count(app, a, ImmoAuditEntry) == 1
    assert count(app, b, ImmoAuditEntry) == 0
    with tenant_session(a, app) as s:
        row = s.query(ImmoAuditEntry).one()
        try:
            s.delete(row)
            s.flush()
            deleted = True
        except Exception:
            deleted = False
            s.rollback()
    assert deleted is False or count(app, a, ImmoAuditEntry) == 1
