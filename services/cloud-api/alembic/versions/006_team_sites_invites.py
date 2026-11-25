"""Team management: sites, invites and a member's home site (UI/UX wiring, P2).

- sites: a workshop's physical locations. Plan caps (Community/Pro/Workshop 1,
  Fleet 3) are enforced by the API. Every existing workshop gets a "Main site".
- tenant_invites: an Owner invites someone by email with a role. Only the
  SHA-256 of the invite token is stored; the token itself is shown once. Open
  invites count against the seat cap until they're accepted, revoked or expire.
- tenant_memberships.site_id: which site a member works at (optional).

Both new tables are tenant-owned: ENABLE + FORCE RLS with the same
tenant_isolation policy as the rest of the schema.

Revision ID: 006
Revises: 005
"""

from __future__ import annotations

from alembic import op

revision = "006"
down_revision = "005"
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
        CREATE TABLE sites (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, name)
        );
        CREATE INDEX sites_tenant ON sites (tenant_id);

        CREATE TABLE tenant_invites (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            email text NOT NULL CHECK (position('@' in email) > 1),
            role membership_role NOT NULL,
            site_id uuid REFERENCES sites (id) ON DELETE SET NULL,
            token_hash text NOT NULL UNIQUE,
            invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL,
            accepted_at timestamptz,
            accepted_by uuid REFERENCES users (id) ON DELETE SET NULL,
            revoked_at timestamptz
        );
        CREATE UNIQUE INDEX ux_tenant_invites_open
            ON tenant_invites (tenant_id, email)
            WHERE accepted_at IS NULL AND revoked_at IS NULL;

        ALTER TABLE tenant_memberships
            ADD COLUMN IF NOT EXISTS site_id uuid REFERENCES sites (id) ON DELETE SET NULL;
        """
    )
    _tenant_rls("sites")
    _tenant_rls("tenant_invites")
    # Backfill: one main site per workshop, and every member works there.
    op.execute("INSERT INTO sites (tenant_id, name) SELECT id, 'Main site' FROM tenants")
    op.execute(
        """
        UPDATE tenant_memberships m SET site_id = s.id
        FROM sites s WHERE s.tenant_id = m.tenant_id AND m.site_id IS NULL
        """
    )
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                GRANT SELECT, INSERT, UPDATE, DELETE ON sites, tenant_invites TO {APP_ROLE};
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE tenant_memberships DROP COLUMN IF EXISTS site_id")
    op.execute("DROP TABLE IF EXISTS tenant_invites")
    op.execute("DROP TABLE IF EXISTS sites")
