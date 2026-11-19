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


@lru_cache
def get_engine() -> Engine:
    return create_engine(get_settings().database_url, pool_pre_ping=True)


@contextmanager
def tenant_session(tenant_id: UUID, engine: Engine | None = None) -> Iterator[Session]:
    """A session whose every statement is filtered to ``tenant_id`` by RLS."""
    with Session(engine or get_engine()) as session, session.begin():
        session.execute(
            text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": str(tenant_id)},
        )
        yield session
