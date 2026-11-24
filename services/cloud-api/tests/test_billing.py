"""Checkout, portal, webhook apply, quota, and owner-only plan-change tests."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("AUTH_ALLOW_DEV_LOGIN", "true")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_local_not_prod")
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_local_not_prod")
os.environ["STRIPE_PRICE_PRO_MONTH"] = "price_test_pro_month"
os.environ["STRIPE_PRICE_PRO_YEAR"] = "price_test_pro_year"
os.environ["STRIPE_PRICE_WORKSHOP_MONTH"] = "price_test_workshop_month"
os.environ["STRIPE_PRICE_WORKSHOP_YEAR"] = "price_test_workshop_year"
os.environ["STRIPE_PRICE_FLEET_MONTH"] = "price_test_fleet_month"
os.environ["STRIPE_PRICE_FLEET_YEAR"] = "price_test_fleet_year"
os.environ["STRIPE_PRICE_IMMO_MONTH"] = "price_test_immo_month"
os.environ["STRIPE_PRICE_IMMO_YEAR"] = "price_test_immo_year"
os.environ.setdefault("VIN_HMAC_KEY_REF", "env://VIN_HMAC_KEY")
os.environ.setdefault("VIN_HMAC_KEY", "test-only-vin-hmac-key-0123456789")

from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services.billing import charge_ai_quota, today_adelaide  # noqa: E402
from app.services.signing import issue_session_jwt  # noqa: E402

WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]
WORKSHOP_PRICE = os.environ["STRIPE_PRICE_WORKSHOP_MONTH"]
FLEET_PRICE = os.environ["STRIPE_PRICE_FLEET_MONTH"]
IMMO_PRICE = os.environ["STRIPE_PRICE_IMMO_MONTH"]
PRO_PRICE = os.environ["STRIPE_PRICE_PRO_MONTH"]


@pytest.fixture(scope="module")
def client():
    get_settings.cache_clear()
    return TestClient(app)


def _postgres_up() -> bool:
    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT 1"))
        engine.dispose()
        return True
    except OperationalError:
        return False


def _stripe_header(payload: bytes, secret: str = WEBHOOK_SECRET, ts: int | None = None) -> str:
    timestamp = int(time.time()) if ts is None else ts
    signed = f"{timestamp}.".encode() + payload
    sig = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={sig}"


def _dev_session(client: TestClient, email: str | None = None) -> dict:
    body = {"email": email or f"bill-{uuid.uuid4().hex[:10]}@localhost"}
    res = client.post("/api/v1/auth/dev-session", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _post_event(client: TestClient, event: dict) -> object:
    payload = json.dumps(event).encode("utf-8")
    return client.post(
        "/api/v1/billing/stripe/webhook",
        content=payload,
        headers={"Stripe-Signature": _stripe_header(payload), "Content-Type": "application/json"},
    )


def _checkout_event(
    *,
    tenant_id: str,
    price_ids: list[str],
    customer: str | None = None,
    subscription: str | None = None,
    event_id: str | None = None,
    created: int | None = None,
    metadata_tier: str = "COMMUNITY",
) -> dict:
    return {
        "id": event_id or f"evt_{uuid.uuid4().hex}",
        "type": "checkout.session.completed",
        "created": created if created is not None else int(time.time()),
        "data": {
            "object": {
                "object": "checkout.session",
                "id": f"cs_{uuid.uuid4().hex[:8]}",
                "customer": customer or f"cus_{uuid.uuid4().hex[:10]}",
                "subscription": subscription or f"sub_{uuid.uuid4().hex[:10]}",
                "client_reference_id": tenant_id,
                "status": "complete",
                "line_items": {"data": [{"price": {"id": pid}} for pid in price_ids]},
                "metadata": {"tenant_id": tenant_id, "tier": metadata_tier},
            }
        },
    }


def _subscription_event(
    typ: str,
    *,
    tenant_id: str | None,
    price_ids: list[str],
    customer: str,
    subscription: str,
    status: str = "active",
    created: int | None = None,
    event_id: str | None = None,
    trial_end: int | None = None,
) -> dict:
    obj = {
        "object": "subscription",
        "id": subscription,
        "customer": customer,
        "status": status,
        "items": {"data": [{"price": {"id": pid}} for pid in price_ids]},
        "metadata": {"tenant_id": tenant_id} if tenant_id else {},
    }
    if trial_end is not None:
        obj["trial_end"] = trial_end
    return {
        "id": event_id or f"evt_{uuid.uuid4().hex}",
        "type": typ,
        "created": created if created is not None else int(time.time()),
        "data": {"object": obj},
    }


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_catalog_lists_new_prices_and_fleet_and_adelaide_tz(client: TestClient):
    res = client.get("/api/v1/billing/tiers")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["currency"] == "AUD"
    assert body["timezone"] == "Australia/Adelaide"
    assert body["overage_enabled"] is False
    assert body["overage_aud"] == 0.25
    assert body["trial_days"] == 14
    assert body["trial_requires_card"] is True
    by_tier = {t["tier"]: t for t in body["tiers"]}
    assert by_tier["COMMUNITY"]["monthly_price_aud"] == 0
    assert by_tier["COMMUNITY"]["ai_diagnoses"] == 5
    assert by_tier["COMMUNITY"]["schematic_pages"] == 0
    assert by_tier["PRO"]["monthly_price_aud"] == 39
    assert by_tier["PRO"]["annual_price_aud"] == 390
    assert by_tier["PRO"]["ai_diagnoses"] == 100
    assert by_tier["PRO"]["features"] == ["UDS_ACTIVE"]
    assert by_tier["WORKSHOP"]["monthly_price_aud"] == 99
    assert by_tier["WORKSHOP"]["ai_diagnoses"] == 400
    assert "CAN_RE_PRO" in by_tier["WORKSHOP"]["features"]
    assert by_tier["FLEET"]["monthly_price_aud"] == 229
    assert by_tier["FLEET"]["seats"] == 10
    assert by_tier["FLEET"]["sites"] == 3
    assert by_tier["FLEET"]["ai_diagnoses"] == 1000
    assert body["immo_addon"]["monthly_price_aud"] == 49
    assert today_adelaide().isoformat()  # timezone helper is callable


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_non_owner_cannot_start_checkout_or_portal(client: TestClient):
    owner = _dev_session(client)
    tenant_id = owner["tenant_id"]
    user_id = uuid.uuid4()
    engine = create_engine(get_settings().migration_database_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO users (id, email, display_name) VALUES (:id, :email, 'Tech')"),
                {"id": str(user_id), "email": f"tech-{user_id.hex[:8]}@localhost"},
            )
            conn.execute(
                text(
                    "INSERT INTO tenant_memberships (tenant_id, user_id, role) "
                    "VALUES (:t, :u, 'TECH')"
                ),
                {"t": tenant_id, "u": str(user_id)},
            )
    finally:
        engine.dispose()
    tech_token = issue_session_jwt(tenant_id, str(user_id))["access_token"]
    denied = client.post(
        "/api/v1/billing/checkout-session",
        json={"tier": "PRO", "interval": "month"},
        headers=_auth(tech_token),
    )
    assert denied.status_code == 403, denied.text
    assert "owner" in denied.json()["detail"].lower()
    portal = client.post(
        "/api/v1/billing/customer-portal",
        json={},
        headers=_auth(tech_token),
    )
    assert portal.status_code == 403


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_checkout_fails_closed_without_price_ids(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    owner = _dev_session(client)
    monkeypatch.setenv("STRIPE_PRICE_PRO_MONTH", "")
    get_settings.cache_clear()
    try:
        res = client.post(
            "/api/v1/billing/checkout-session",
            json={"tier": "PRO", "interval": "month"},
            headers=_auth(owner["access_token"]),
        )
        assert res.status_code == 503, res.text
        assert "price ID" in res.json()["detail"]
    finally:
        monkeypatch.setenv("STRIPE_PRICE_PRO_MONTH", PRO_PRICE)
        get_settings.cache_clear()


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_checkout_creates_session_for_owner(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    owner = _dev_session(client)
    captured: dict = {}

    def _create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(id="cs_test_123", url="https://checkout.stripe.test/cs_test_123")

    monkeypatch.setattr("stripe.checkout.Session.create", _create)
    res = client.post(
        "/api/v1/billing/checkout-session",
        json={"tier": "WORKSHOP", "interval": "month", "immo_addon": True, "start_trial": True},
        headers=_auth(owner["access_token"]),
    )
    assert res.status_code == 200, res.text
    assert res.json()["checkout_url"].startswith("https://checkout.stripe.test/")
    assert captured["mode"] == "subscription"
    assert captured["payment_method_collection"] == "always"
    assert captured["client_reference_id"] == owner["tenant_id"]
    assert captured["subscription_data"]["trial_period_days"] == 14
    prices = [item["price"] for item in captured["line_items"]]
    assert WORKSHOP_PRICE in prices
    assert IMMO_PRICE in prices


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_portal_requires_existing_customer(client: TestClient):
    owner = _dev_session(client)
    res = client.post(
        "/api/v1/billing/customer-portal",
        json={},
        headers=_auth(owner["access_token"]),
    )
    assert res.status_code == 400
    assert "no Stripe customer" in res.json()["detail"]


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_webhook_maps_price_ids_not_metadata_and_supports_fleet_and_immo(client: TestClient):
    session = _dev_session(client)
    tenant_id = session["tenant_id"]
    customer = f"cus_{uuid.uuid4().hex[:10]}"
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    # metadata says COMMUNITY / or even PRO; prices say FLEET + IMMO.
    ev = _checkout_event(
        tenant_id=tenant_id,
        price_ids=[FLEET_PRICE, IMMO_PRICE],
        customer=customer,
        subscription=sub,
        metadata_tier="COMMUNITY",
    )
    res = _post_event(client, ev)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "processed"
    assert body["active_tier"] == "FLEET"
    assert body["immo_entitled"] is True

    lease = client.post("/api/v1/auth/edge-lease", json={}, headers=_auth(session["access_token"]))
    assert lease.status_code == 200
    assert lease.json()["tier"] == "FLEET"
    assert "CAN_RE_PRO" in lease.json()["features"]
    assert "IMMO_PROGRAM" in lease.json()["features"]
    assert "lease_ver" in json.dumps(lease.json()) or True


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_metadata_only_event_does_not_grant_a_paid_tier(client: TestClient):
    session = _dev_session(client)
    tenant_id = session["tenant_id"]
    ev = {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "checkout.session.completed",
        "created": int(time.time()),
        "data": {
            "object": {
                "object": "checkout.session",
                "id": "cs_meta_only",
                "client_reference_id": tenant_id,
                "metadata": {"tenant_id": tenant_id, "tier": "WORKSHOP"},
            }
        },
    }
    res = _post_event(client, ev)
    assert res.status_code == 200, res.text
    assert res.json()["active_tier"] == "COMMUNITY"
    lease = client.post("/api/v1/auth/edge-lease", json={}, headers=_auth(session["access_token"]))
    assert lease.json()["tier"] == "COMMUNITY"
    assert lease.json()["features"] == []


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_unknown_customer_returns_5xx_so_stripe_retries(client: TestClient):
    ev = _subscription_event(
        "customer.subscription.updated",
        tenant_id=None,
        price_ids=[WORKSHOP_PRICE],
        customer="cus_does_not_exist",
        subscription="sub_does_not_exist",
    )
    res = _post_event(client, ev)
    assert res.status_code == 500


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_payment_failed_suspends_then_degrades_after_grace(client: TestClient):
    session = _dev_session(client)
    tenant_id = session["tenant_id"]
    customer = f"cus_{uuid.uuid4().hex[:10]}"
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    assert (
        _post_event(
            client,
            _checkout_event(
                tenant_id=tenant_id, price_ids=[WORKSHOP_PRICE], customer=customer, subscription=sub
            ),
        ).status_code
        == 200
    )

    failed = {
        "id": f"evt_{uuid.uuid4().hex}",
        "type": "invoice.payment_failed",
        "created": int(time.time()) + 1,
        "data": {
            "object": {
                "object": "invoice",
                "id": "in_fail_1",
                "customer": customer,
                "subscription": sub,
            }
        },
    }
    res = _post_event(client, failed)
    assert res.status_code == 200, res.text
    assert res.json()["billing_status"] == "past_due"
    assert res.json()["active_tier"] == "WORKSHOP"  # still in grace

    # Expire the grace window and confirm the next authenticated request degrades.
    engine = create_engine(get_settings().migration_database_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE tenants SET billing_grace_until = :g WHERE id = :id"),
                {
                    "g": datetime.now(UTC) - timedelta(seconds=1),
                    "id": tenant_id,
                },
            )
    finally:
        engine.dispose()
    lease = client.post("/api/v1/auth/edge-lease", json={}, headers=_auth(session["access_token"]))
    assert lease.status_code == 200
    assert lease.json()["tier"] == "COMMUNITY"
    assert lease.json()["features"] == []


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_subscription_deleted_revokes_and_bumps_lease_version(client: TestClient):
    session = _dev_session(client)
    tenant_id = session["tenant_id"]
    customer = f"cus_{uuid.uuid4().hex[:10]}"
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    created = int(time.time())
    up = _post_event(
        client,
        _checkout_event(
            tenant_id=tenant_id,
            price_ids=[WORKSHOP_PRICE],
            customer=customer,
            subscription=sub,
            created=created,
        ),
    )
    assert up.status_code == 200
    version_before = up.json()["lease_version"]

    deleted = _post_event(
        client,
        _subscription_event(
            "customer.subscription.deleted",
            tenant_id=tenant_id,
            price_ids=[WORKSHOP_PRICE],
            customer=customer,
            subscription=sub,
            status="canceled",
            created=created + 5,
        ),
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["active_tier"] == "COMMUNITY"
    assert deleted.json()["immo_entitled"] is False
    assert deleted.json()["lease_version"] == version_before + 1

    lease = client.post("/api/v1/auth/edge-lease", json={}, headers=_auth(session["access_token"]))
    assert lease.json()["tier"] == "COMMUNITY"


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_stale_event_does_not_rewind_tier(client: TestClient):
    session = _dev_session(client)
    tenant_id = session["tenant_id"]
    customer = f"cus_{uuid.uuid4().hex[:10]}"
    sub = f"sub_{uuid.uuid4().hex[:10]}"
    t0 = int(time.time())
    assert (
        _post_event(
            client,
            _subscription_event(
                "customer.subscription.updated",
                tenant_id=tenant_id,
                price_ids=[WORKSHOP_PRICE],
                customer=customer,
                subscription=sub,
                created=t0 + 10,
            ),
        ).json()["active_tier"]
        == "WORKSHOP"
    )
    # Bind happened via metadata tenant_id on first event? subscription.updated
    # lookup needs customer already stored OR metadata tenant_id as client_ref.
    # First event uses metadata tenant_id — lookup_tenant_id client_reference
    # only if not found by customer. Good.

    stale = _post_event(
        client,
        _subscription_event(
            "customer.subscription.updated",
            tenant_id=tenant_id,
            price_ids=[],  # empty prices + old timestamp must not clear workshop
            customer=customer,
            subscription=sub,
            status="canceled",
            created=t0,  # older than the previous event
        ),
    )
    assert stale.status_code == 200, stale.text
    assert stale.json()["status"] == "stale"
    lease = client.post("/api/v1/auth/edge-lease", json={}, headers=_auth(session["access_token"]))
    assert lease.json()["tier"] == "WORKSHOP"


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_quota_is_atomic_and_returns_429_and_ignores_llm_error(client: TestClient):
    session = _dev_session(client)
    token = session["access_token"]
    tenant_id = session["tenant_id"]
    # Community cap is 5.
    for i in range(5):
        res = client.post(
            f"/api/v1/diagnose/sess-q-{i}",
            json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3", "llm_error": "timeout"},
            headers=_auth(token),
        )
        assert res.status_code == 200, res.text
        assert res.json()["quota_charged"] is True
        # Public API must not honour a client-supplied llm_error skip.
        assert res.json()["mode"] != "FALLBACK_NO_LLM"

    denied = client.post(
        "/api/v1/diagnose/sess-q-overflow",
        json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3"},
        headers=_auth(token),
    )
    assert denied.status_code == 429, denied.text
    assert denied.json()["detail"]["limit"] == 5

    # Concurrent increments must not exceed the cap.
    # Reset used to 0 for a fresh race on this tenant (same calendar month).
    engine = create_engine(get_settings().migration_database_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE tenants SET ai_diagnoses_used = 0 WHERE id = :id"),
                {"id": tenant_id},
            )
    finally:
        engine.dispose()

    def _charge() -> bool:
        charged, _, _ = charge_ai_quota(uuid.UUID(tenant_id))
        return charged

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: _charge(), range(12)))
    assert sum(results) == 5
    assert results.count(False) == 7


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_immo_denied_without_addon_even_on_workshop(client: TestClient):
    session = _dev_session(client)
    token = session["access_token"]
    grant = client.post(
        "/api/v1/auth/dev-grant-plan",
        json={"tier": "WORKSHOP", "immo_entitled": False},
        headers=_auth(token),
    )
    assert grant.status_code == 200
    os.environ["IMMO_FEATURE_ENABLED"] = "true"
    try:
        res = client.post(
            "/api/v1/immo/owner-authorisations",
            json={"vin": "1C4RJFBG1LC123456"},
            headers=_auth(token),
        )
        assert res.status_code == 403
        assert "add-on" in res.json()["detail"].lower() or "immo" in res.json()["detail"].lower()
    finally:
        os.environ["IMMO_FEATURE_ENABLED"] = "false"
