"""Mobile plan: add MOBILE to the subscription_tier enum, with 90-day telemetry retention.

The plan's prices, quotas and features live in packages/schemas/plan_features.json;
only the enum value and its retention row are stored here. Downgrade refuses while
any tenant is on MOBILE, then removes the retention row. Postgres can't cheaply drop
an enum value, so MOBILE stays on the type (as FLEET does in 004).

Revision ID: 014
Revises: 013
"""

from __future__ import annotations

from sqlalchemy import text

from alembic import op

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ADD VALUE can't run inside a transaction block on some Postgres versions.
    with op.get_context().autocommit_block():
        op.execute(
            "ALTER TYPE subscription_tier ADD VALUE IF NOT EXISTS 'MOBILE' AFTER 'COMMUNITY'"
        )
    op.execute(
        """
        INSERT INTO tier_retention (tier, telemetry_days) VALUES ('MOBILE', 90)
        ON CONFLICT (tier) DO NOTHING
        """
    )


def downgrade() -> None:
    in_use = (
        op.get_bind()
        .execute(text("SELECT count(*) FROM tenants WHERE subscription_tier::text = 'MOBILE'"))
        .scalar()
    )
    if in_use:
        raise RuntimeError(f"{in_use} tenant(s) are on MOBILE; move them before downgrading")
    op.execute("DELETE FROM tier_retention WHERE tier = 'MOBILE'")
