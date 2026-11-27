"""Skip guards for tests that need the database migrated, not just reachable.

CI and fresh checkouts can have Postgres up but unmigrated; those tests must
skip with a clear reason, never error (same rule as the "needs Postgres
migrated to NNN" guards in the older suites).
"""

from __future__ import annotations

from functools import cache

from sqlalchemy import create_engine, text


@cache
def migrated_to_012() -> bool:
    """Postgres reachable and migrated through 012 (can_trace_outbox)."""
    from app.config import get_settings

    try:
        engine = create_engine(get_settings().database_url)
        try:
            with engine.connect() as c:
                c.execute(text("SELECT 1 FROM users LIMIT 0"))
                c.execute(text("SELECT 1 FROM can_trace_outbox LIMIT 0"))
        finally:
            engine.dispose()
        return True
    except Exception:  # noqa: BLE001 - unreachable, or an older schema
        return False


NEEDS_012 = "needs Postgres migrated to 012 (cd services/cloud-api && uv run alembic upgrade head)"
