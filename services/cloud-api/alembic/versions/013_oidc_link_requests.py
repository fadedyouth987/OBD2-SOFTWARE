"""OIDC account linking needs the account holder's confirmation (review H3, 2026-11-28).

A provider sign-in whose email matches an existing RootCause account no longer
links to it on the provider's word (``email_verified``). It leaves a pending
request instead, confirmed either by the account holder signed in to RootCause
(password or existing session) or by a single-use link emailed to the
account's address. Each request keeps only hashes of its two tokens, is
single-use and expires after 30 minutes. Like oidc_login_states, it's read
before anyone is signed in, so only the owner role touches it: RLS forced with
no policies and no grants to the app role.

Revision ID: 013
Revises: 012
"""

from __future__ import annotations

from alembic import op

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE oidc_link_requests (
            id uuid PRIMARY KEY,
            user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            oidc_issuer text NOT NULL,
            oidc_subject text NOT NULL,
            provider_name text NOT NULL,
            session_token_hash text NOT NULL UNIQUE,
            email_token_hash text NOT NULL UNIQUE,
            invite_token text,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL,
            used_at timestamptz
        )
        """
    )
    op.execute("CREATE INDEX oidc_link_requests_expiry ON oidc_link_requests (expires_at)")
    op.execute("CREATE INDEX oidc_link_requests_user ON oidc_link_requests (user_id)")
    op.execute("ALTER TABLE oidc_link_requests ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE oidc_link_requests FORCE ROW LEVEL SECURITY")
    op.execute("REVOKE ALL ON oidc_link_requests FROM PUBLIC")


def downgrade() -> None:
    op.execute("DROP TABLE oidc_link_requests")
