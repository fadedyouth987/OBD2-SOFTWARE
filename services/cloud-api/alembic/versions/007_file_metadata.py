"""File metadata for schematic and DBC uploads (UI/UX wiring, P2).

The original tables only had a title/name and an S3 key. Uploads now record
what the file is (type, size, SHA-256), who uploaded it, and which vehicle
profile it's for, so the app can list, check and stream them.

Revision ID: 007
Revises: 006
"""

from __future__ import annotations

from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE wiring_schematics
            ADD COLUMN IF NOT EXISTS vehicle_profile TEXT,
            ADD COLUMN IF NOT EXISTS content_type TEXT,
            ADD COLUMN IF NOT EXISTS size_bytes INTEGER,
            ADD COLUMN IF NOT EXISTS sha256 TEXT,
            ADD COLUMN IF NOT EXISTS uploaded_by UUID REFERENCES users (id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS ix_wiring_schematics_tenant_created
            ON wiring_schematics (tenant_id, created_at DESC);

        ALTER TABLE custom_dbc_files
            ADD COLUMN IF NOT EXISTS vehicle_profile TEXT,
            ADD COLUMN IF NOT EXISTS size_bytes INTEGER,
            ADD COLUMN IF NOT EXISTS message_count INTEGER;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DROP INDEX IF EXISTS ix_wiring_schematics_tenant_created;
        ALTER TABLE wiring_schematics
            DROP COLUMN IF EXISTS vehicle_profile,
            DROP COLUMN IF EXISTS content_type,
            DROP COLUMN IF EXISTS size_bytes,
            DROP COLUMN IF EXISTS sha256,
            DROP COLUMN IF EXISTS uploaded_by;
        ALTER TABLE custom_dbc_files
            DROP COLUMN IF EXISTS vehicle_profile,
            DROP COLUMN IF EXISTS size_bytes,
            DROP COLUMN IF EXISTS message_count;
        """
    )
