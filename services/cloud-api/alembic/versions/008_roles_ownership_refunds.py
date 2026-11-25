"""Ownership transfer, team audit trail, and schematic page refunds.

- ownership_transfers: an Owner offers ownership to a member; the member
  accepts or declines. One pending offer per workshop (partial unique index).
- team_audit_events: append-only record of team changes (invites, role and
  site changes, removals, ownership offers and hand-overs).
- wiring_schematics.pages_charged / charged_period: what an upload cost and in
  which quota month, so deleting it in the same month gives the pages back.
  Existing rows are backfilled from page_count and created_at (Adelaide month).

All new tables are tenant-owned: ENABLE + FORCE RLS with tenant_isolation.

Revision ID: 008
Revises: 007
"""

from __future__ import annotations

from alembic import op

revision = "008"
down_revision = "007"
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
        CREATE TABLE ownership_transfers (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            from_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            to_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL,
            status text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED')),
            resolved_at timestamptz,
            CHECK (from_user_id <> to_user_id)
        );
        CREATE UNIQUE INDEX ux_ownership_transfers_pending
            ON ownership_transfers (tenant_id) WHERE status = 'PENDING';

        CREATE TABLE team_audit_events (
            id bigserial PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            at timestamptz NOT NULL DEFAULT now(),
            actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            action text NOT NULL,
            subject_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
            subject_email text,
            detail jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX ix_team_audit_tenant_at ON team_audit_events (tenant_id, at DESC);

        ALTER TABLE wiring_schematics
            ADD COLUMN IF NOT EXISTS pages_charged INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS charged_period DATE;
        UPDATE wiring_schematics
           SET pages_charged = COALESCE(page_count, 0),
               charged_period = date_trunc(
                   'month', created_at AT TIME ZONE 'Australia/Adelaide')::date
         WHERE charged_period IS NULL;
        """
    )
    _tenant_rls("ownership_transfers")
    _tenant_rls("team_audit_events")
    # The audit trail is append-only for the app role.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                GRANT SELECT, INSERT, UPDATE ON ownership_transfers TO {APP_ROLE};
                GRANT SELECT, INSERT ON team_audit_events TO {APP_ROLE};
                GRANT USAGE ON SEQUENCE team_audit_events_id_seq TO {APP_ROLE};
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE wiring_schematics
            DROP COLUMN IF EXISTS pages_charged,
            DROP COLUMN IF EXISTS charged_period;
        DROP TABLE IF EXISTS team_audit_events;
        DROP TABLE IF EXISTS ownership_transfers;
        """
    )
