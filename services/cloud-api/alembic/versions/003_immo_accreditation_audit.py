"""Technician accreditation, immobilizer sessions, and five-year immo audit.

Revision ID: 003
Revises: 002

New tables are ENABLE + FORCE ROW LEVEL SECURITY with tenant isolation,
matching Task 2.1. ``immo_audit`` is append-only for the app role (SELECT,
INSERT) and is retained for five years. No column stores a PIN, key code,
or SecurityAccess secret.
"""

from __future__ import annotations

from alembic import op

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None

APP_ROLE = "diag_app"

TENANT_TABLES = (
    "technician_credentials",
    "owner_authorisations",
    "immo_sessions",
    "immo_audit",
)


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
        CREATE TABLE technician_credentials (
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            aasra_member_id text NOT NULL CHECK (length(aasra_member_id) BETWEEN 1 AND 64),
            vsp_status text NOT NULL DEFAULT 'pending'
                CHECK (vsp_status IN ('pending', 'active', 'expired')),
            national_police_check_dated date,
            repairer_licence_renewed_at date,
            declaration_at timestamptz,
            accredited_until timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, user_id),
            CHECK (
                national_police_check_dated IS NOT NULL
                OR repairer_licence_renewed_at IS NOT NULL
            )
        )
        """
    )

    op.execute(
        """
        CREATE TABLE owner_authorisations (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
            vin_hmac text NOT NULL CHECK (vin_hmac ~ '^[0-9a-f]{64}$'),
            declared_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, id)
        )
        """
    )
    op.execute(
        "CREATE INDEX owner_authorisations_vin "
        "ON owner_authorisations (tenant_id, vin_hmac)"
    )

    op.execute(
        """
        CREATE TABLE immo_sessions (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
            authorisation_id uuid NOT NULL,
            vin_hmac text NOT NULL CHECK (vin_hmac ~ '^[0-9a-f]{64}$'),
            oem text NOT NULL,
            operation text NOT NULL,
            device_id text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 128),
            device_tier text NOT NULL CHECK (
                device_tier IN ('dongle', 'vci', 'vci_programmer')
            ),
            lease_jti text NOT NULL,
            expires_at timestamptz NOT NULL,
            status text NOT NULL CHECK (status IN (
                'pending', 'active', 'completed', 'aborted', 'refused'
            )),
            token_fetched_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            completed_at timestamptz,
            UNIQUE (tenant_id, id),
            UNIQUE (lease_jti),
            FOREIGN KEY (tenant_id, authorisation_id)
                REFERENCES owner_authorisations (tenant_id, id)
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX immo_sessions_one_active_vin
            ON immo_sessions (tenant_id, vin_hmac)
            WHERE status IN ('pending', 'active')
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX immo_sessions_one_active_device
            ON immo_sessions (tenant_id, device_id)
            WHERE status IN ('pending', 'active')
        """
    )

    op.execute(
        """
        CREATE TABLE immo_audit (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
            session_id uuid,
            at timestamptz NOT NULL DEFAULT now(),
            user_id uuid,
            aasra_member_id text,
            vin_hmac text,
            device_id text,
            device_tier text,
            oem text,
            operation text,
            event text NOT NULL CHECK (event IN (
                'requested', 'issued', 'allowed', 'refused',
                'response', 'aborted', 'completed', 'token_fetched'
            )),
            nrc smallint CHECK (nrc BETWEEN 0 AND 255),
            detail text NOT NULL DEFAULT '',
            retain_until timestamptz NOT NULL
                DEFAULT (now() + interval '5 years'),
            created_at timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX immo_audit_tenant_at ON immo_audit (tenant_id, at)"
    )
    op.execute(
        "COMMENT ON TABLE immo_audit IS "
        "'MVIS-aligned five-year security-information audit. Never store PINs or key codes.'"
    )

    for table in TENANT_TABLES:
        _tenant_rls(table)

    op.execute(
        f"""
        GRANT SELECT, INSERT, UPDATE ON technician_credentials, owner_authorisations, immo_sessions
            TO {APP_ROLE};
        GRANT SELECT, INSERT ON immo_audit TO {APP_ROLE};
        GRANT USAGE, SELECT ON SEQUENCE immo_audit_id_seq TO {APP_ROLE};
        """
    )


def downgrade() -> None:
    op.execute(
        f"REVOKE ALL ON TABLE technician_credentials, owner_authorisations, "
        f"immo_sessions, immo_audit FROM {APP_ROLE}"
    )
    op.execute(f"REVOKE ALL ON SEQUENCE immo_audit_id_seq FROM {APP_ROLE}")
    op.execute("DROP TABLE IF EXISTS immo_audit")
    op.execute("DROP TABLE IF EXISTS immo_sessions")
    op.execute("DROP TABLE IF EXISTS owner_authorisations")
    op.execute("DROP TABLE IF EXISTS technician_credentials")
