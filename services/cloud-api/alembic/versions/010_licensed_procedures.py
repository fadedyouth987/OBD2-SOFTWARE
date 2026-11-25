"""Licensed OEM service procedures, versioned, with source and licence metadata.

- procedure_sources: who licensed the data to us and on what terms (licence
  text or reference, optional URL and end date). After ``licensed_until`` its
  procedures stop being offered.
- procedure_records: one procedure for one service function on a make/model/
  year range, as delivered by the source (``source_ref``). Re-importing a
  changed procedure adds a new version and marks the old one SUPERSEDED, so a
  job can always say exactly which version it ran. Nothing here is invented:
  rows only come from an admin import or the licensed provider feed.
- diagnostic_sessions.vehicle_make / vehicle_model / model_year: the vehicle
  identity procedures are matched on (the VIN's WMI and year code fill what
  they can; the technician confirms the model).

Procedures are reference data shared by every workshop, so these two tables
have no RLS; the app role can only read them. Imports use the owner role.

Revision ID: 010
Revises: 009
"""

from __future__ import annotations

from alembic import op

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None

APP_ROLE = "diag_app"


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE procedure_sources (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
            name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
            licence text NOT NULL CHECK (length(btrim(licence)) BETWEEN 3 AND 2000),
            licence_url text,
            licensed_until date,
            provider text NOT NULL DEFAULT 'import' CHECK (provider IN ('import', 'feed')),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
        );

        CREATE TABLE procedure_records (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            source_id uuid NOT NULL REFERENCES procedure_sources (id) ON DELETE CASCADE,
            source_ref text NOT NULL CHECK (length(btrim(source_ref)) BETWEEN 1 AND 120),
            version integer NOT NULL CHECK (version >= 1),
            status text NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'WITHDRAWN')),
            function_id text NOT NULL,
            make text NOT NULL,
            model text NOT NULL,
            make_key text NOT NULL,
            model_key text NOT NULL,
            year_from integer NOT NULL CHECK (year_from BETWEEN 1980 AND 2100),
            year_to integer NOT NULL CHECK (year_to BETWEEN 1980 AND 2100),
            engine text,
            module text NOT NULL,
            procedure jsonb NOT NULL,
            notes text,
            sha256 text NOT NULL,
            imported_at timestamptz NOT NULL DEFAULT now(),
            imported_by uuid REFERENCES users (id) ON DELETE SET NULL,
            CHECK (year_from <= year_to),
            UNIQUE (source_id, source_ref, version)
        );
        CREATE UNIQUE INDEX ux_procedure_records_active
            ON procedure_records (source_id, source_ref) WHERE status = 'ACTIVE';
        CREATE INDEX ix_procedure_records_match
            ON procedure_records (make_key, model_key, function_id) WHERE status = 'ACTIVE';

        ALTER TABLE diagnostic_sessions
            ADD COLUMN IF NOT EXISTS vehicle_make TEXT,
            ADD COLUMN IF NOT EXISTS vehicle_model TEXT,
            ADD COLUMN IF NOT EXISTS model_year INTEGER
                CHECK (model_year IS NULL OR model_year BETWEEN 1980 AND 2100);
        """
    )
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
                GRANT SELECT ON procedure_sources, procedure_records TO {APP_ROLE};
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE diagnostic_sessions
            DROP COLUMN IF EXISTS vehicle_make,
            DROP COLUMN IF EXISTS vehicle_model,
            DROP COLUMN IF EXISTS model_year;
        DROP TABLE IF EXISTS procedure_records;
        DROP TABLE IF EXISTS procedure_sources;
        """
    )
