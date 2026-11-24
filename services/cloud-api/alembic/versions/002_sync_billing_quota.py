"""Session sync idempotency, Stripe event log, and monthly AI quota period.

Revision ID: 002
Revises: 001

New tables are ENABLE + FORCE ROW LEVEL SECURITY with tenant isolation, matching
Task 2.1. ``stripe_events.tenant_id`` is the shop the webhook applied to; the
app role can only insert/read a row while that tenant is set on the session.
"""

from __future__ import annotations

from alembic import op

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None

APP_ROLE = "diag_app"


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE tenants
            ADD COLUMN IF NOT EXISTS ai_quota_period_start date
            NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date
        """
    )

    op.execute(
        """
        CREATE TABLE sync_batches (
            tenant_id uuid NOT NULL REFERENCES tenants(id),
            batch_id text NOT NULL,
            edge_session_id text NOT NULL,
            session_id uuid NOT NULL REFERENCES diagnostic_sessions(id),
            watermark_us bigint NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, batch_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE stripe_events (
            event_id text PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants(id),
            event_type text NOT NULL,
            payload jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )

    for table in ("sync_batches", "stripe_events"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (tenant_id = app_current_tenant()) "
            "WITH CHECK (tenant_id = app_current_tenant())"
        )

    op.execute(
        f"""
        GRANT SELECT, INSERT ON sync_batches, stripe_events TO {APP_ROLE}
        """
    )


def downgrade() -> None:
    op.execute(f"REVOKE ALL ON TABLE sync_batches, stripe_events FROM {APP_ROLE}")
    op.execute("DROP TABLE IF EXISTS stripe_events")
    op.execute("DROP TABLE IF EXISTS sync_batches")
    op.execute("ALTER TABLE tenants DROP COLUMN IF EXISTS ai_quota_period_start")
