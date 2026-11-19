"""Multi-tenant schema with row-level security (Task 2.1).

- Every tenant-owned table has ENABLE + FORCE ROW LEVEL SECURITY and a policy
  on ``app_current_tenant()``, which reads ``app.current_tenant_id``. An unset
  or empty setting is NULL, so nothing matches: access fails closed.
  Exception: the compressed ``telemetry_samples`` hypertable (TimescaleDB
  cannot compress a table with row security). The app role has no privileges
  on it and uses the tenant-filtered ``telemetry`` view instead.
- The API connects as ``diag_app`` (A-ENG-5): not the owner, not a superuser,
  no BYPASSRLS, and append-only on audit and telemetry tables. The tenant is
  set per transaction with ``set_config(..., true)`` (``SET LOCAL``).
- ``telemetry_samples`` is a TimescaleDB hypertable, compressed after 7 days;
  ``prune_telemetry_by_tier`` deletes samples older than the tenant's tier
  retention, daily (A-ENG-9).
- ``audit_log`` receives the edge daemon's gated-command audit, one row per
  attempt, idempotent on (tenant, edge session, sequence) (A-CEO-4).
- ``resolved_cases`` is the anonymized, shared case corpus (no tenant link
  after anonymization, Task 2.2): readable by every tenant, insert-only.

The owner role runs migrations and maintenance jobs. It must be a superuser
or have BYPASSRLS (the dev ``diag`` role is a superuser); the app role never.

Revision ID: 001
Revises:
Create Date: 2026-11-19
"""

import os

from alembic import op

revision = "001"
down_revision = None
branch_labels = None
depends_on = None

APP_ROLE = "diag_app"

TENANT_TABLES = [
    "tenant_memberships",
    "vehicles",
    "diagnostic_sessions",
    "custom_dbc_files",
    "wiring_schematics",
    "audit_log",
]

# Telemetry retention per tier [estimated defaults; tune with pricing].
RETENTION_DAYS = {"COMMUNITY": 30, "PRO": 365, "WORKSHOP": 730}


def _tenant_rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON {table} "
        "USING (tenant_id = app_current_tenant()) "
        "WITH CHECK (tenant_id = app_current_tenant())"
    )


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.execute("CREATE TYPE membership_role AS ENUM ('OWNER', 'LEAD_TECH', 'TECH')")
    op.execute("CREATE TYPE subscription_tier AS ENUM ('COMMUNITY', 'PRO', 'WORKSHOP')")

    op.execute(
        """
        CREATE FUNCTION app_current_tenant() RETURNS uuid
        LANGUAGE sql STABLE PARALLEL SAFE
        AS $$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid $$
        """
    )

    op.execute(
        """
        CREATE TABLE tenants (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
            subscription_tier subscription_tier NOT NULL DEFAULT 'COMMUNITY',
            ai_diagnoses_used integer NOT NULL DEFAULT 0 CHECK (ai_diagnoses_used >= 0),
            schematic_pages_used integer NOT NULL DEFAULT 0 CHECK (schematic_pages_used >= 0),
            aasra_verified boolean NOT NULL DEFAULT false,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE users (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            email text NOT NULL UNIQUE CHECK (position('@' in email) > 1),
            display_name text,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE tenant_memberships (
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            role membership_role NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, user_id)
        );
        CREATE INDEX tenant_memberships_user ON tenant_memberships (user_id);

        CREATE TABLE vehicles (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            vin_hmac text NOT NULL CHECK (vin_hmac ~ '^[0-9a-f]{64}$'),
            wmi_vds text CHECK (wmi_vds ~ '^[A-HJ-NPR-Z0-9]{9}$'),
            make text,
            model text,
            year smallint CHECK (year BETWEEN 1950 AND 2100),
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, vin_hmac),
            UNIQUE (tenant_id, id)
        );

        CREATE TABLE diagnostic_sessions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            vehicle_id uuid,
            user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            edge_session_id text,
            protocol text,
            started_at timestamptz NOT NULL DEFAULT now(),
            ended_at timestamptz,
            summary jsonb NOT NULL DEFAULT '{}'::jsonb,
            UNIQUE (tenant_id, edge_session_id),
            UNIQUE (tenant_id, id),
            -- A session can only point at a vehicle of the same tenant.
            FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles (tenant_id, id)
        );

        CREATE TABLE telemetry_samples (
            time timestamptz NOT NULL,
            tenant_id uuid NOT NULL,
            session_id uuid NOT NULL,
            pid smallint NOT NULL,
            name text NOT NULL,
            value double precision NOT NULL,
            unit text NOT NULL DEFAULT ''
        );

        CREATE TABLE resolved_cases (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            wmi_vds text CHECK (wmi_vds ~ '^[A-HJ-NPR-Z0-9]{9}$'),
            engine_family text,
            dtcs text[] NOT NULL DEFAULT '{}',
            canonical_summary text NOT NULL,
            fix_description text NOT NULL,
            feature_vector real[],
            embedding vector(384),
            embedding_model text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX resolved_cases_embedding_hnsw
            ON resolved_cases USING hnsw (embedding vector_cosine_ops);
        CREATE INDEX resolved_cases_wmi_vds ON resolved_cases (wmi_vds);

        CREATE TABLE custom_dbc_files (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            name text NOT NULL,
            s3_key text NOT NULL,
            sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
            created_by uuid REFERENCES users (id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE wiring_schematics (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            vehicle_id uuid,
            title text NOT NULL,
            s3_key text NOT NULL,
            page_count integer CHECK (page_count BETWEEN 1 AND 200),
            status text NOT NULL DEFAULT 'UPLOADED'
                CHECK (status IN ('UPLOADED', 'PROCESSING', 'READY', 'FAILED')),
            created_at timestamptz NOT NULL DEFAULT now(),
            FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles (tenant_id, id)
        );

        CREATE TABLE audit_log (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            edge_session_id text NOT NULL,
            seq bigint NOT NULL CHECK (seq >= 0),
            at timestamptz NOT NULL,
            user_ref text,
            vehicle_ref text,
            ecu text NOT NULL,
            service text NOT NULL,
            tier char(1) CHECK (tier IN ('A', 'B')),
            outcome text NOT NULL CHECK (outcome IN (
                'allowed', 'refused', 'response', 'logged',
                'token_issued', 'token_refused', 'bench_mode')),
            code text,
            nrc smallint CHECK (nrc BETWEEN 0 AND 255),
            detail text NOT NULL DEFAULT '',
            received_at timestamptz NOT NULL DEFAULT now(),
            -- One row per attempt: re-syncing the same record is a no-op.
            UNIQUE (tenant_id, edge_session_id, seq)
        );

        CREATE TABLE tier_retention (
            tier subscription_tier PRIMARY KEY,
            telemetry_days integer NOT NULL CHECK (telemetry_days > 0)
        );
        """
    )
    values = ", ".join(f"('{tier}', {days})" for tier, days in RETENTION_DAYS.items())
    op.execute(f"INSERT INTO tier_retention (tier, telemetry_days) VALUES {values}")

    # Telemetry hypertable, compressed after 7 days (A-ENG-9).
    op.execute("SELECT create_hypertable('telemetry_samples', by_range('time', INTERVAL '1 day'))")
    op.execute(
        "CREATE INDEX telemetry_samples_session "
        "ON telemetry_samples (tenant_id, session_id, time DESC)"
    )
    op.execute(
        """
        ALTER TABLE telemetry_samples SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'tenant_id, session_id',
            timescaledb.compress_orderby = 'time DESC'
        )
        """
    )
    op.execute("SELECT add_compression_policy('telemetry_samples', INTERVAL '7 days')")

    # Retention by tier, run daily by the owner (who bypasses RLS).
    op.execute(
        """
        CREATE PROCEDURE prune_telemetry_by_tier(
            job_id integer DEFAULT NULL, config jsonb DEFAULT NULL)
        LANGUAGE plpgsql AS $$
        BEGIN
            DELETE FROM telemetry_samples s
            USING tenants t
            JOIN tier_retention r ON r.tier = t.subscription_tier
            WHERE s.tenant_id = t.id
              AND s.time < now() - make_interval(days => r.telemetry_days);
        END
        $$
        """
    )
    op.execute("SELECT add_job('prune_telemetry_by_tier', INTERVAL '1 day')")

    # Row-level security.
    for table in TENANT_TABLES:
        _tenant_rls(table)

    # TimescaleDB cannot compress a table with row security (either order), and
    # A-ENG-9 needs compression. So the app role gets no privileges on the
    # hypertable and works through a tenant-filtered view instead: the
    # security barrier stops leaky predicates, and CHECK OPTION rejects inserts
    # for any other tenant. Isolation equals RLS; the tests prove it.
    op.execute(
        """
        CREATE VIEW telemetry WITH (security_barrier = true) AS
            SELECT time, tenant_id, session_id, pid, name, value, unit
            FROM telemetry_samples
            WHERE tenant_id = app_current_tenant()
        WITH CASCADED CHECK OPTION
        """
    )
    op.execute(
        """
        ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
        CREATE POLICY tenant_self ON tenants
            USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

        -- Users are global (one person can work for several workshops); a tenant
        -- sees only its own members. Sign-up inserts happen before membership.
        ALTER TABLE users ENABLE ROW LEVEL SECURITY;
        ALTER TABLE users FORCE ROW LEVEL SECURITY;
        CREATE POLICY users_member_read ON users FOR SELECT USING (
            EXISTS (SELECT 1 FROM tenant_memberships m
                    WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()));
        CREATE POLICY users_member_update ON users FOR UPDATE USING (
            EXISTS (SELECT 1 FROM tenant_memberships m
                    WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()));
        CREATE POLICY users_signup ON users FOR INSERT WITH CHECK (true);

        -- Anonymized shared corpus: every tenant reads, inserts only via publish.
        ALTER TABLE resolved_cases ENABLE ROW LEVEL SECURITY;
        ALTER TABLE resolved_cases FORCE ROW LEVEL SECURITY;
        CREATE POLICY cases_read ON resolved_cases FOR SELECT
            USING (app_current_tenant() IS NOT NULL);
        CREATE POLICY cases_publish ON resolved_cases FOR INSERT
            WITH CHECK (app_current_tenant() IS NOT NULL);
        """
    )

    # The application role (A-ENG-5).
    password = os.environ.get("APP_DB_PASSWORD", "diag_app")
    op.execute(
        f"""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                CREATE ROLE {APP_ROLE} LOGIN PASSWORD {_quote_literal(password)}
                    NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
            END IF;
        END
        $$
        """
    )
    op.execute(
        f"""
        GRANT USAGE ON SCHEMA public TO {APP_ROLE};
        GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, tenant_memberships, vehicles,
            diagnostic_sessions, custom_dbc_files, wiring_schematics TO {APP_ROLE};
        GRANT SELECT, INSERT ON telemetry, audit_log, resolved_cases TO {APP_ROLE};
        GRANT SELECT ON tier_retention TO {APP_ROLE};
        GRANT EXECUTE ON FUNCTION app_current_tenant() TO {APP_ROLE};
        """
    )


def downgrade() -> None:
    op.execute(
        "SELECT delete_job(job_id) FROM timescaledb_information.jobs "
        "WHERE proc_name = 'prune_telemetry_by_tier'"
    )
    op.execute("DROP PROCEDURE IF EXISTS prune_telemetry_by_tier(integer, jsonb)")
    op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {APP_ROLE}")
    op.execute(f"REVOKE ALL ON SCHEMA public FROM {APP_ROLE}")
    op.execute(f"REVOKE EXECUTE ON FUNCTION app_current_tenant() FROM {APP_ROLE}")
    op.execute("DROP VIEW IF EXISTS telemetry")
    for table in [
        "audit_log",
        "wiring_schematics",
        "custom_dbc_files",
        "resolved_cases",
        "telemetry_samples",
        "diagnostic_sessions",
        "vehicles",
        "tenant_memberships",
        "users",
        "tier_retention",
        "tenants",
    ]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    op.execute("DROP FUNCTION IF EXISTS app_current_tenant()")
    op.execute("DROP TYPE IF EXISTS subscription_tier")
    op.execute("DROP TYPE IF EXISTS membership_role")
    # The role is cluster-wide and may serve other databases; it is not dropped.
