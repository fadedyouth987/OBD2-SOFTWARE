"""Raw CAN traces from session sync, through a transactional outbox (Task 2.2, A-CEO-2).

- can_trace_outbox: one row per session per sync batch that carried raw CAN
  frames. The gzipped candump log is written in the batch's own transaction,
  so a batch is stored with its trace or not at all. It's uploaded to S3 after
  commit; if S3 is down the row stays pending (body kept, attempts and
  last_error recorded) and ``python -m app.cli drain-can-traces`` uploads it
  later. Once uploaded the body is dropped and the row stays as the session's
  trace index (key, frame count, time range).
- Tenant RLS, forced. The app role can read, insert and mark uploads; it
  cannot delete. The cross-tenant drain runs as the owner role.

Revision ID: 012
Revises: 011
"""

from __future__ import annotations

from alembic import op

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None

APP_ROLE = "diag_app"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE can_trace_outbox (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            batch_id text NOT NULL,
            session_id uuid NOT NULL REFERENCES diagnostic_sessions(id) ON DELETE CASCADE,
            s3_key text NOT NULL UNIQUE,
            frame_count integer NOT NULL CHECK (frame_count > 0),
            first_timestamp_us bigint NOT NULL,
            last_timestamp_us bigint NOT NULL,
            body bytea,
            attempts integer NOT NULL DEFAULT 0,
            last_error text,
            created_at timestamptz NOT NULL DEFAULT now(),
            uploaded_at timestamptz,
            -- Pending rows keep their body; uploaded rows drop it.
            CHECK ((uploaded_at IS NULL) = (body IS NOT NULL)),
            UNIQUE (tenant_id, batch_id, session_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX can_trace_outbox_pending ON can_trace_outbox (created_at) "
        "WHERE uploaded_at IS NULL"
    )
    op.execute("CREATE INDEX can_trace_outbox_session ON can_trace_outbox (tenant_id, session_id)")
    op.execute("ALTER TABLE can_trace_outbox ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE can_trace_outbox FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON can_trace_outbox "
        "USING (tenant_id = app_current_tenant()) "
        "WITH CHECK (tenant_id = app_current_tenant())"
    )
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON can_trace_outbox TO {APP_ROLE}")


def downgrade() -> None:
    op.execute(f"REVOKE ALL ON TABLE can_trace_outbox FROM {APP_ROLE}")
    op.execute("DROP TABLE IF EXISTS can_trace_outbox")
