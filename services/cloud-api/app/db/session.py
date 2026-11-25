"""Tenant-scoped database sessions (A-ENG-5).

Every unit of work runs in one transaction that first sets
``app.current_tenant_id`` with ``set_config(..., true)``: the bindable form of
``SET LOCAL``. It ends with the transaction, so a pooled connection handed to
the next request carries no tenant: RLS then shows nothing (fail closed).
"""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache
from uuid import UUID

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session

from app.config import get_settings


def _pooled(url: str, *, size: int, overflow: int) -> Engine:
    settings = get_settings()
    return create_engine(
        url,
        pool_pre_ping=True,
        pool_size=max(1, size),
        max_overflow=max(0, overflow),
        pool_recycle=settings.db_pool_recycle_s,
        pool_timeout=settings.db_pool_timeout_s,
    )


@lru_cache
def get_engine() -> Engine:
    """The tenant-scoped (RLS) role's pool, shared by every request in the process."""
    s = get_settings()
    return _pooled(s.database_url, size=s.db_pool_size, overflow=s.db_max_overflow)


@lru_cache
def owner_engine() -> Engine:
    """The owner role's pool, for the few lookups that happen before a tenant is known.

    Kept small: sign-in by email, invite lookups, Stripe webhook tenant lookups,
    and platform-admin reviews. Everything else goes through ``tenant_session``.
    """
    s = get_settings()
    return _pooled(
        s.migration_database_url, size=s.owner_db_pool_size, overflow=s.owner_db_max_overflow
    )


@contextmanager
def tenant_session(tenant_id: UUID, engine: Engine | None = None) -> Iterator[Session]:
    """A session whose every statement is filtered to ``tenant_id`` by RLS."""
    with Session(engine or get_engine()) as session, session.begin():
        session.execute(
            text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": str(tenant_id)},
        )
        yield session
