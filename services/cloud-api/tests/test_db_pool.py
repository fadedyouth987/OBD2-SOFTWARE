"""One pooled engine per database role for the whole process (no engine per call)."""

from __future__ import annotations

import sqlalchemy

from app.db import session as db_session


def test_engines_are_process_singletons():
    assert db_session.get_engine() is db_session.get_engine()
    assert db_session.owner_engine() is db_session.owner_engine()
    assert db_session.get_engine() is not db_session.owner_engine()


def test_pools_use_configured_sizes():
    app_pool = db_session.get_engine().pool
    owner_pool = db_session.owner_engine().pool
    settings = db_session.get_settings()
    assert app_pool.size() == settings.db_pool_size
    assert owner_pool.size() == settings.owner_db_pool_size
    assert db_session.get_engine().pool._pre_ping is True


def test_owner_lookups_do_not_create_engines(monkeypatch):
    """The sign-in, dev-session and Stripe lookups reuse the owner pool."""
    from app.api.v1 import auth
    from app.services import billing, identity

    created: list[str] = []
    real = sqlalchemy.create_engine

    def spy(*args, **kwargs):
        created.append(str(args[0]) if args else "")
        return real(*args, **kwargs)

    monkeypatch.setattr(sqlalchemy, "create_engine", spy)
    db_session.owner_engine()  # warm the cached engine before counting
    for module in (auth, billing, identity):
        assert not hasattr(module, "create_engine"), module.__name__
    try:
        identity.user_by_email("nobody-pool-test@example.com")
        billing.lookup_tenant_id(customer_id="cus_pool_test_missing")
    except Exception:  # noqa: BLE001 - no Postgres in this environment
        pass
    assert created == []
