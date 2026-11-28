"""Provider sign-in started from the Android app: a second PKCE leg for the hand-off.

The app opens the provider in the system browser (Google refuses embedded web
views). The web callback page hands ``code`` and ``state`` back to the app over its
``rootcause://`` link, which another app could also register. So the app sends a
challenge with /oidc/start and must present the matching verifier to redeem: a
copied ``code`` and ``state`` are useless without it.

Revision ID: 015
Revises: 014
"""

from __future__ import annotations

from alembic import op

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE oidc_login_states ADD COLUMN client_challenge text")


def downgrade() -> None:
    op.execute("ALTER TABLE oidc_login_states DROP COLUMN client_challenge")
