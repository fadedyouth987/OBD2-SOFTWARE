"""Password sign-in and the diagnostic session workflow (UI/UX wiring, P0).

- users: password hash, failed-attempt lockout and last sign-in.
- diagnostic_sessions: status (OPEN/CLOSED), vehicle, adapter, lease tier,
  DTCs, heuristic alerts, AI diagnosis and the close-out record that feeds the
  customer report. The full VIN is never stored: only the HMAC and a redacted
  form (WMI + VDS).

Revision ID: 005
Revises: 004
"""

from __future__ import annotations

from alembic import op

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS password_hash TEXT,
            ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
        """
    )
    op.execute(
        """
        ALTER TABLE diagnostic_sessions
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'OPEN',
            ADD COLUMN IF NOT EXISTS vehicle_label TEXT,
            ADD COLUMN IF NOT EXISTS vehicle_profile TEXT,
            ADD COLUMN IF NOT EXISTS vin_hmac TEXT,
            ADD COLUMN IF NOT EXISTS vin_redacted TEXT,
            ADD COLUMN IF NOT EXISTS odometer_km INTEGER,
            ADD COLUMN IF NOT EXISTS adapter_id TEXT,
            ADD COLUMN IF NOT EXISTS adapter_kind TEXT,
            ADD COLUMN IF NOT EXISTS daemon_version TEXT,
            ADD COLUMN IF NOT EXISTS lease_tier TEXT,
            ADD COLUMN IF NOT EXISTS customer_ref TEXT,
            ADD COLUMN IF NOT EXISTS complaint TEXT,
            ADD COLUMN IF NOT EXISTS dtcs JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS diagnosis JSONB,
            ADD COLUMN IF NOT EXISTS closeout JSONB,
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        """
    )
    op.execute(
        """
        ALTER TABLE diagnostic_sessions
            ADD CONSTRAINT ck_diagnostic_sessions_status
            CHECK (status IN ('OPEN', 'CLOSED'))
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_diagnostic_sessions_tenant_edge
            ON diagnostic_sessions (tenant_id, edge_session_id)
            WHERE edge_session_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_diagnostic_sessions_tenant_started
            ON diagnostic_sessions (tenant_id, started_at DESC)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_diagnostic_sessions_tenant_started")
    op.execute("DROP INDEX IF EXISTS ux_diagnostic_sessions_tenant_edge")
    op.execute(
        "ALTER TABLE diagnostic_sessions DROP CONSTRAINT IF EXISTS ck_diagnostic_sessions_status"
    )
    op.execute(
        """
        ALTER TABLE diagnostic_sessions
            DROP COLUMN IF EXISTS status,
            DROP COLUMN IF EXISTS vehicle_label,
            DROP COLUMN IF EXISTS vehicle_profile,
            DROP COLUMN IF EXISTS vin_hmac,
            DROP COLUMN IF EXISTS vin_redacted,
            DROP COLUMN IF EXISTS odometer_km,
            DROP COLUMN IF EXISTS adapter_id,
            DROP COLUMN IF EXISTS adapter_kind,
            DROP COLUMN IF EXISTS daemon_version,
            DROP COLUMN IF EXISTS lease_tier,
            DROP COLUMN IF EXISTS customer_ref,
            DROP COLUMN IF EXISTS complaint,
            DROP COLUMN IF EXISTS dtcs,
            DROP COLUMN IF EXISTS alerts,
            DROP COLUMN IF EXISTS diagnosis,
            DROP COLUMN IF EXISTS closeout,
            DROP COLUMN IF EXISTS updated_at
        """
    )
    op.execute(
        """
        ALTER TABLE users
            DROP COLUMN IF EXISTS password_hash,
            DROP COLUMN IF EXISTS failed_logins,
            DROP COLUMN IF EXISTS locked_until,
            DROP COLUMN IF EXISTS last_login_at
        """
    )
