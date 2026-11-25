"""OIDC sign-in (AWS Cognito): linked identities and one-time login states.

- users.oidc_issuer / users.oidc_subject: the identity provider's stable id for
  the person (``iss`` + ``sub`` of the ID token). Unique together, so one
  provider account maps to one RootCause user. password_hash may stay NULL for
  people who only sign in through the provider.
- oidc_login_states: one row per sign-in attempt, keyed by a hash of the
  ``state`` sent to the provider, holding the nonce and PKCE verifier. A row is
  single-use and expires after 10 minutes. It's read before anyone is signed
  in, so only the owner role touches it: RLS is forced with no policies and the
  app role has no grants.

Revision ID: 011
Revises: 010
"""

from __future__ import annotations

from alembic import op

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN oidc_issuer text, ADD COLUMN oidc_subject text")
    op.execute(
        "ALTER TABLE users ADD CONSTRAINT users_oidc_pair CHECK "
        "((oidc_issuer IS NULL) = (oidc_subject IS NULL))"
    )
    op.execute(
        "CREATE UNIQUE INDEX users_oidc_identity ON users (oidc_issuer, oidc_subject) "
        "WHERE oidc_subject IS NOT NULL"
    )
    op.execute(
        """
        CREATE TABLE oidc_login_states (
            state_hash text PRIMARY KEY,
            nonce text NOT NULL,
            code_verifier text NOT NULL,
            return_to text NOT NULL DEFAULT '/',
            invite_token text,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL,
            used_at timestamptz
        )
        """
    )
    op.execute("CREATE INDEX oidc_login_states_expiry ON oidc_login_states (expires_at)")
    op.execute("ALTER TABLE oidc_login_states ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE oidc_login_states FORCE ROW LEVEL SECURITY")
    op.execute("REVOKE ALL ON oidc_login_states FROM PUBLIC")


def downgrade() -> None:
    op.execute("DROP TABLE oidc_login_states")
    op.execute("DROP INDEX users_oidc_identity")
    op.execute("ALTER TABLE users DROP CONSTRAINT users_oidc_pair")
    op.execute("ALTER TABLE users DROP COLUMN oidc_subject, DROP COLUMN oidc_issuer")
