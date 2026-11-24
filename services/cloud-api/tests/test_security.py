"""Authentication, Stripe webhook, and tenant-isolation API tests."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("AUTH_ALLOW_DEV_LOGIN", "true")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_local_not_prod")

os.environ["STRIPE_PRICE_PRO_MONTH"] = "price_test_pro_month"
os.environ["STRIPE_PRICE_PRO_YEAR"] = "price_test_pro_year"
os.environ["STRIPE_PRICE_WORKSHOP_MONTH"] = "price_test_workshop_month"
os.environ["STRIPE_PRICE_WORKSHOP_YEAR"] = "price_test_workshop_year"
os.environ["STRIPE_PRICE_FLEET_MONTH"] = "price_test_fleet_month"
os.environ["STRIPE_PRICE_FLEET_YEAR"] = "price_test_fleet_year"
os.environ["STRIPE_PRICE_IMMO_MONTH"] = "price_test_immo_month"
os.environ["STRIPE_PRICE_IMMO_YEAR"] = "price_test_immo_year"
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_local_not_prod")

from app.main import app  # noqa: E402

WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _postgres_up() -> bool:
    from app.config import get_settings

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
    body = {"email": email or f"dev-{uuid.uuid4().hex[:10]}@localhost"}
    res = client.post("/api/v1/auth/dev-session", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_unauthenticated_edge_lease_is_401(client: TestClient):
    res = client.post(
        "/api/v1/auth/edge-lease",
        json={
            "tenant_id": "t_attacker",
            "user_id": "u_attacker",
            "tier": "WORKSHOP",
            "aasra_verified": True,
        },
    )
    assert res.status_code == 401


def test_unauthenticated_pairing_sessions_gateways_diagnose_are_401(client: TestClient):
    assert (
        client.post(
            "/api/v1/auth/edge-pairing", json={"origin": "http://localhost:3000"}
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/sessions/sync",
            json={"batch_id": "b", "session_id": "s", "watermark_us": 1, "tenant_id": "t_attacker"},
        ).status_code
        == 401
    )
    assert client.get("/api/v1/sessions/s").status_code == 401
    assert (
        client.post(
            "/api/v1/gateways/aasra/verify",
            json={
                "workshop_abn": "12 345 678 901",
                "aasra_member_id": "A1",
                "oem": "Ford",
                "vsp_authorized": True,
            },
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/gateways/sgw/unlock",
            json={
                "tenant_id": "t_attacker",
                "user_id": "u",
                "vin": "1C4RJFBG1LC123456",
                "oem": "Jeep",
                "autoauth_account": "x",
            },
        ).status_code
        == 401
    )
    assert client.post("/api/v1/diagnose/sess-1", json={"dtcs": ["P2463"]}).status_code == 401
    assert (
        client.post("/api/v1/vehicles/decode", json={"vin": "MPBUMFF60PX418290"}).status_code == 401
    )
    assert (
        client.post(
            "/api/v1/cases/publish",
            json={
                "engine_family": "x",
                "dtcs": ["P0001"],
                "symptom_summary": "s",
                "verified_fix": "f",
            },
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/dbc", json={"tenant_id": "t", "name": "a.dbc", "vehicle_profile": "p"}
        ).status_code
        == 401
    )


def test_client_cannot_use_get_vin_decode(client: TestClient):
    res = client.get("/api/v1/vehicles/decode/MPBUMFF60PX418290")
    assert res.status_code == 405
    assert "MPBUMFF60PX418290" not in res.text


def test_forged_stripe_webhook_rejected(client: TestClient):
    payload = json.dumps({"id": "evt_forged", "type": "invoice.paid"}).encode("utf-8")
    res = client.post(
        "/api/v1/billing/stripe/webhook",
        content=payload,
        headers={
            "Stripe-Signature": _stripe_header(payload, secret="whsec_wrong"),
            "Content-Type": "application/json",
        },
    )
    assert res.status_code == 400


def test_stripe_webhook_without_secret_fails_closed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
):
    from app.config import get_settings

    payload = json.dumps({"id": "evt_nosecret", "type": "invoice.paid"}).encode("utf-8")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "")
    get_settings.cache_clear()
    try:
        res = client.post(
            "/api/v1/billing/stripe/webhook",
            content=payload,
            headers={
                "Stripe-Signature": _stripe_header(payload),
                "Content-Type": "application/json",
            },
        )
        assert res.status_code == 503
    finally:
        monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET)
        get_settings.cache_clear()


def test_vehicles_catalog_stays_public(client: TestClient):
    res = client.get("/api/v1/vehicles")
    assert res.status_code == 200
    assert res.json()["oem_platform_count"] >= 1


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_dev_session_lease_ignores_client_identity(client: TestClient):
    session = _dev_session(client)
    token = session["access_token"]
    tenant_id = session["tenant_id"]
    res = client.post(
        "/api/v1/auth/edge-lease",
        json={
            "tenant_id": "t_attacker",
            "user_id": "u_attacker",
            "tier": "WORKSHOP",
            "aasra_verified": True,
        },
        headers=_auth(token),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["tier"] == "COMMUNITY"
    assert body["features"] == []
    # Claims come from the server-side principal, not the attacker-supplied body.
    import base64

    payload = body["token"].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert claims["tenant_id"] == tenant_id
    assert claims["aasra_verified"] is False
    assert claims["tier"] == "COMMUNITY"


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_aasra_and_sgw_ignore_client_flags_until_marked(client: TestClient):
    session = _dev_session(client)
    token = session["access_token"]
    aasra = client.post(
        "/api/v1/gateways/aasra/verify",
        json={
            "workshop_abn": "12 345 678 901",
            "aasra_member_id": "AASRA-9921",
            "oem": "Ford",
            "vsp_authorized": True,
            "tenant_id": "t_attacker",
        },
        headers=_auth(token),
    )
    assert aasra.status_code == 200
    assert aasra.json()["eligible"] is False
    assert "immo_lease" not in aasra.json()

    denied = client.post(
        "/api/v1/gateways/sgw/unlock",
        json={"oem": "Jeep", "vin": "1C4RJFBG1LC123456", "autoauth_account": "shop"},
        headers=_auth(token),
    )
    assert denied.status_code == 403
    assert "1C4RJFBG1LC123456" not in denied.text

    marked = client.post("/api/v1/auth/dev-mark-aasra", headers=_auth(token))
    assert marked.status_code == 200
    unlocked = client.post(
        "/api/v1/gateways/sgw/unlock",
        json={"oem": "Jeep", "vin": "1C4RJFBG1LC123456", "autoauth_account": "shop"},
        headers=_auth(token),
    )
    assert unlocked.status_code == 200, unlocked.text
    body = unlocked.json()
    assert "vin" not in body and "vin_last4" not in body
    assert "SGW_UNLOCK" not in body["sgw_session_lease"]["features"]


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_stripe_webhook_upgrades_tier_and_rejects_replay(client: TestClient):
    session = _dev_session(client)
    tenant_id = session["tenant_id"]
    now = int(time.time())
    payload = json.dumps(
        {
            "id": f"evt_{uuid.uuid4().hex}",
            "type": "checkout.session.completed",
            "created": now,
            "data": {
                "object": {
                    "object": "checkout.session",
                    "id": "cs_test_upgrade",
                    "customer": f"cus_{uuid.uuid4().hex[:8]}",
                    "subscription": f"sub_{uuid.uuid4().hex[:8]}",
                    "client_reference_id": tenant_id,
                    "status": "complete",
                    "line_items": {"data": [{"price": {"id": "price_test_workshop_month"}}]},
                    # metadata.tier must be ignored if it disagrees with the price id
                    "metadata": {"tenant_id": tenant_id, "tier": "FLEET"},
                }
            },
        }
    ).encode("utf-8")
    res = client.post(
        "/api/v1/billing/stripe/webhook",
        content=payload,
        headers={"Stripe-Signature": _stripe_header(payload), "Content-Type": "application/json"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["status"] == "processed"
    assert res.json()["active_tier"] == "WORKSHOP"

    replay = client.post(
        "/api/v1/billing/stripe/webhook",
        content=payload,
        headers={"Stripe-Signature": _stripe_header(payload), "Content-Type": "application/json"},
    )
    assert replay.status_code == 200
    assert replay.json()["status"] == "duplicate_ignored"

    lease = client.post(
        "/api/v1/auth/edge-lease",
        json={},
        headers=_auth(session["access_token"]),
    )
    assert lease.status_code == 200
    assert lease.json()["tier"] == "WORKSHOP"
    assert "J2534" in lease.json()["features"]


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_session_sync_and_case_publish_round_trip(client: TestClient):
    session = _dev_session(client)
    headers = _auth(session["access_token"])
    edge_session = f"sess-sec-{uuid.uuid4().hex[:10]}"
    batch = {
        "batch_id": f"batch-{uuid.uuid4()}",
        "tenant_id": "t_attacker",
        "session_id": edge_session,
        "watermark_us": 1000,
        "telemetry_rows": [{"pid": 12, "value": 780, "name": "rpm VIN MPBUMFF60PX418290"}],
        "audit_entries": [
            {
                "seq": 1,
                "action": "0x04",
                "status": "APPROVED",
                "detail": "cleared MPBUMFF60PX418290",
            }
        ],
    }
    first = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert first.status_code == 200, first.text
    assert first.json()["status"] == "accepted"
    second = client.post("/api/v1/sessions/sync", json=batch, headers=headers)
    assert second.json()["status"] == "duplicate_ignored"
    got = client.get(f"/api/v1/sessions/{edge_session}", headers=headers)
    assert got.status_code == 200
    body = got.json()
    assert body["watermark_us"] == 1000
    blob = json.dumps(body)
    assert "MPBUMFF60PX418290" not in blob

    pub = client.post(
        "/api/v1/cases/publish",
        json={
            "vin": "MPBUMFF60PX418290",
            "engine_family": "Ford 3.0L V6 PowerStroke",
            "dtcs": ["P2463"],
            "symptom_summary": "DPF soot warning under load",
            "verified_fix": "Replaced split DPF differential pressure hose",
            "parts_replaced": ["DPF Hose"],
        },
        headers=headers,
    )
    assert pub.status_code == 200, pub.text
    assert "MPBUMFF60PX418290" not in json.dumps(pub.json())
    case_id = pub.json()["case"]["case_id"]

    diag = client.post(
        f"/api/v1/diagnose/{edge_session}",
        json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3"},
        headers=headers,
    )
    assert diag.status_code == 200, diag.text
    assert diag.json()["quota_charged"] is True
    assert case_id in diag.json()["ranked_causes"][0]["cited_case_ids"]


@pytest.mark.skipif(not _postgres_up(), reason="needs Postgres")
def test_dev_login_disabled_is_404(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("AUTH_ALLOW_DEV_LOGIN", "false")
    res = client.post("/api/v1/auth/dev-session", json={"email": "nope@localhost"})
    assert res.status_code == 404
