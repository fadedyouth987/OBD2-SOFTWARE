"""Add FLEET tier, Stripe IDs, lease version, IMMO entitlement, and billing state.

Revision ID: 004
Revises: 003
"""

from __future__ import annotations

from alembic import op

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ADD VALUE must run outside a transaction on some Postgres versions.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE subscription_tier ADD VALUE IF NOT EXISTS 'FLEET'")

    op.execute(
        """
        INSERT INTO tier_retention (tier, telemetry_days) VALUES ('FLEET', 730)
        ON CONFLICT (tier) DO NOTHING
        """
    )
    op.execute(
        """
        ALTER TABLE tenants
            ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
            ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
            ADD COLUMN IF NOT EXISTS stripe_subscription_status TEXT NOT NULL DEFAULT 'none',
            ADD COLUMN IF NOT EXISTS billing_grace_until TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS billing_event_created BIGINT NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS lease_version INTEGER NOT NULL DEFAULT 0,
            ADD COLUMN IF NOT EXISTS immo_entitled BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS trial_used BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS site_count INTEGER NOT NULL DEFAULT 1
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_stripe_customer_id
            ON tenants (stripe_customer_id)
            WHERE stripe_customer_id IS NOT NULL
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_stripe_subscription_id
            ON tenants (stripe_subscription_id)
            WHERE stripe_subscription_id IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ux_tenants_stripe_subscription_id")
    op.execute("DROP INDEX IF EXISTS ux_tenants_stripe_customer_id")
    op.execute(
        """
        ALTER TABLE tenants
            DROP COLUMN IF EXISTS stripe_customer_id,
            DROP COLUMN IF EXISTS stripe_subscription_id,
            DROP COLUMN IF EXISTS stripe_subscription_status,
            DROP COLUMN IF EXISTS billing_grace_until,
            DROP COLUMN IF EXISTS billing_event_created,
            DROP COLUMN IF EXISTS lease_version,
            DROP COLUMN IF EXISTS immo_entitled,
            DROP COLUMN IF EXISTS trial_used,
            DROP COLUMN IF EXISTS trial_ends_at,
            DROP COLUMN IF EXISTS site_count
        """
    )
    op.execute("DELETE FROM tier_retention WHERE tier = 'FLEET'")
    # Postgres cannot cheaply drop an enum value; leave FLEET on the type.
