"""AASRA / MVIS accreditation reviewed by a platform admin.

- users.platform_admin: platform operators who review accreditation and import
  licensed procedures. Granted only from the command line
  (``python -m app.cli grant-platform-admin <email>``), never through the API.
- tenants.aasra_verified_until: workshop accreditation now expires.
- accreditation_requests: a workshop's or technician's submitted details; a
  platform admin approves (with an expiry) or rejects (with a reason).
  ``reminders_sent`` records which "lapses in N days" emails went out.
- accreditation_evidence: uploaded proof (PDF/PNG/JPEG) stored privately in S3.
- accreditation_events: append-only audit of every submission, decision,
  reminder, revocation and lapse.

The three new tables are tenant-owned (ENABLE + FORCE RLS). Admin review reads
across workshops through the owner connection, like invite lookups.

Revision ID: 009
Revises: 008
"""

from __future__ import annotations

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None

APP_ROLE = "diag_app"


def _tenant_rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON {table} "
        "USING (tenant_id = app_current_tenant()) "
        "WITH CHECK (tenant_id = app_current_tenant())"
    )


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS aasra_verified_until TIMESTAMPTZ;
        -- A reviewed credential can also be rejected or revoked.
        ALTER TABLE technician_credentials
            DROP CONSTRAINT IF EXISTS technician_credentials_vsp_status_check;
        ALTER TABLE technician_credentials
            ADD CONSTRAINT technician_credentials_vsp_status_check
            CHECK (vsp_status IN ('pending', 'active', 'expired', 'rejected', 'revoked'));

        CREATE TABLE accreditation_requests (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            kind text NOT NULL CHECK (kind IN ('WORKSHOP', 'TECHNICIAN')),
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            aasra_member_id text NOT NULL CHECK (length(btrim(aasra_member_id)) BETWEEN 1 AND 64),
            business_abn text,
            national_police_check_dated date,
            repairer_licence_renewed_at date,
            declaration_at timestamptz NOT NULL,
            status text NOT NULL DEFAULT 'PENDING' CHECK (
                status IN ('PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED', 'EXPIRED', 'REVOKED')
            ),
            submitted_at timestamptz NOT NULL DEFAULT now(),
            reviewed_at timestamptz,
            reviewed_by uuid REFERENCES users (id) ON DELETE SET NULL,
            decision_reason text,
            expires_at timestamptz,
            reminders_sent integer[] NOT NULL DEFAULT '{}'
        );
        CREATE INDEX ix_accreditation_requests_status
            ON accreditation_requests (status, submitted_at);
        CREATE INDEX ix_accreditation_requests_subject
            ON accreditation_requests (tenant_id, kind, user_id, submitted_at DESC);
        -- One open request per subject (a technician, or a workshop).
        CREATE UNIQUE INDEX ux_accreditation_pending_tech
            ON accreditation_requests (tenant_id, user_id)
            WHERE status = 'PENDING' AND kind = 'TECHNICIAN';
        CREATE UNIQUE INDEX ux_accreditation_pending_workshop
            ON accreditation_requests (tenant_id)
            WHERE status = 'PENDING' AND kind = 'WORKSHOP';

        CREATE TABLE accreditation_evidence (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id uuid NOT NULL REFERENCES accreditation_requests (id) ON DELETE CASCADE,
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            s3_key text NOT NULL,
            filename text NOT NULL,
            content_type text NOT NULL,
            size_bytes integer NOT NULL,
            sha256 text NOT NULL,
            uploaded_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX ix_accreditation_evidence_request ON accreditation_evidence (request_id);

        CREATE TABLE accreditation_events (
            id bigserial PRIMARY KEY,
            request_id uuid NOT NULL REFERENCES accreditation_requests (id) ON DELETE CASCADE,
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            at timestamptz NOT NULL DEFAULT now(),
            actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            event text NOT NULL,
            detail jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX ix_accreditation_events_request ON accreditation_events (request_id, at);
        """
    )
    for table in ("accreditation_requests", "accreditation_evidence", "accreditation_events"):
        _tenant_rls(table)
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                GRANT SELECT, INSERT, UPDATE ON accreditation_requests TO {APP_ROLE};
                GRANT SELECT, INSERT ON accreditation_evidence TO {APP_ROLE};
                GRANT SELECT, INSERT ON accreditation_events TO {APP_ROLE};
                GRANT USAGE ON SEQUENCE accreditation_events_id_seq TO {APP_ROLE};
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP TABLE IF EXISTS accreditation_events;
        DROP TABLE IF EXISTS accreditation_evidence;
        DROP TABLE IF EXISTS accreditation_requests;
        UPDATE technician_credentials SET vsp_status = 'expired'
         WHERE vsp_status IN ('rejected', 'revoked');
        ALTER TABLE technician_credentials
            DROP CONSTRAINT IF EXISTS technician_credentials_vsp_status_check;
        ALTER TABLE technician_credentials
            ADD CONSTRAINT technician_credentials_vsp_status_check
            CHECK (vsp_status IN ('pending', 'active', 'expired'));
        ALTER TABLE tenants DROP COLUMN IF EXISTS aasra_verified_until;
        ALTER TABLE users DROP COLUMN IF EXISTS platform_admin;
        """
    )
