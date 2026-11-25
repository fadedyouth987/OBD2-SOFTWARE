"""Immobilizer Phase 1 gates: deny paths first, then the sandbox happy path."""

from __future__ import annotations

import os
import uuid
from contextlib import contextmanager
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("AUTH_ALLOW_DEV_LOGIN", "true")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_local_not_prod")
os.environ.setdefault("VIN_HMAC_KEY_REF", "env://VIN_HMAC_KEY")
os.environ.setdefault("VIN_HMAC_KEY", "test-only-vin-hmac-key-0123456789")
# Flag stays off unless a test turns it on.
os.environ["IMMO_FEATURE_ENABLED"] = "false"

from app.main import app  # noqa: E402
from app.services.immo_catalog import (  # noqa: E402
    IMMO_LEASE_MAX_TTL_S,
    SANDBOX_DEVICE_ID,
    SANDBOX_DEVICE_TIER,
    SANDBOX_KEY_HEX,
    SANDBOX_OEM,
    SANDBOX_OPERATION,
    SANDBOX_VIN,
)
from app.services.signing import issue_edge_lease, issue_immo_lease  # noqa: E402

IMMO_PATHS = (
    "/api/v1/immo/technicians/enrol",
    "/api/v1/immo/owner-authorisations",
    "/api/v1/immo/sessions",
)


@pytest.fixture
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


def _require_db() -> None:
    if not _postgres_up():
        pytest.skip("needs Postgres")


@contextmanager
def flags(*, immo: bool, dev_login: bool = True):
    old_immo = os.environ.get("IMMO_FEATURE_ENABLED")
    old_dev = os.environ.get("AUTH_ALLOW_DEV_LOGIN")
    os.environ["IMMO_FEATURE_ENABLED"] = "true" if immo else "false"
    os.environ["AUTH_ALLOW_DEV_LOGIN"] = "true" if dev_login else "false"
    try:
        yield
    finally:
        if old_immo is None:
            os.environ.pop("IMMO_FEATURE_ENABLED", None)
        else:
            os.environ["IMMO_FEATURE_ENABLED"] = old_immo
        if old_dev is None:
            os.environ.pop("AUTH_ALLOW_DEV_LOGIN", None)
        else:
            os.environ["AUTH_ALLOW_DEV_LOGIN"] = old_dev


def _dev_session(client: TestClient) -> dict:
    res = client.post(
        "/api/v1/auth/dev-session",
        json={"email": f"immo-{uuid.uuid4().hex[:10]}@localhost"},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _grant_immo_plan(client: TestClient, token: str) -> None:
    res = client.post(
        "/api/v1/auth/dev-grant-plan",
        headers=_auth(token),
        json={"tier": "WORKSHOP", "immo_entitled": True},
    )
    assert res.status_code == 200, res.text


def _mark_aasra(client: TestClient, token: str) -> None:
    _grant_immo_plan(client, token)
    with flags(immo=True, dev_login=True):
        res = client.post("/api/v1/auth/dev-mark-aasra", headers=_auth(token))
    assert res.status_code == 200, res.text


def test_unauthenticated_immo_routes_are_401(client: TestClient):
    for path in IMMO_PATHS:
        assert client.post(path, json={"vin": SANDBOX_VIN}).status_code == 401
    sid = str(uuid.uuid4())
    assert client.post(f"/api/v1/immo/sessions/{sid}/token").status_code == 401
    assert client.post(f"/api/v1/immo/sessions/{sid}/complete").status_code == 401
    assert client.post(f"/api/v1/immo/sessions/{sid}/abort").status_code == 401
    assert client.get(f"/api/v1/immo/sessions/{sid}").status_code == 401
    assert client.get("/api/v1/immo/technicians/me").status_code == 401


def test_feature_flag_off_is_403(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    with flags(immo=False):
        res = client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(sess["access_token"]),
            json={
                "aasra_member_id": "VSP-TEST-1",
                "national_police_check_dated": date.today().isoformat(),
                "declared": True,
            },
        )
    assert res.status_code == 403
    assert "not enabled" in res.json()["detail"].lower()


def test_diagnostic_lease_never_includes_immo_program():
    issued = issue_edge_lease(str(uuid.uuid4()), str(uuid.uuid4()), tier="WORKSHOP")
    assert "IMMO_PROGRAM" not in issued["features"]
    assert issued["features"] == ["UDS_ACTIVE", "CAN_RE_PRO", "J2534"]


def test_immo_lease_ttl_is_capped():
    issued = issue_immo_lease(
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        session_id=str(uuid.uuid4()),
        jti=str(uuid.uuid4()),
        vin=SANDBOX_VIN,
        device_id=SANDBOX_DEVICE_ID,
        device_tier=SANDBOX_DEVICE_TIER,
        oem=SANDBOX_OEM,
        operation=SANDBOX_OPERATION,
        ttl_s=24 * 3600,
    )
    import time

    assert issued["expires_at"] - int(time.time()) <= IMMO_LEASE_MAX_TTL_S
    assert issued["lease_kind"] == "immo_lease"
    assert issued["features"] == ["IMMO_PROGRAM"]
    # Raw VIN is bound inside the JWT, not echoed in the JSON envelope.
    assert "vin" not in issued


def test_start_denied_without_aasra_workshop(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    _grant_immo_plan(client, sess["access_token"])
    token = sess["access_token"]
    with flags(immo=True):
        enrol = client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(token),
            json={
                "aasra_member_id": "VSP-TEST-1",
                "national_police_check_dated": date.today().isoformat(),
                "declared": True,
            },
        )
        assert enrol.status_code == 200, enrol.text
        assert enrol.json()["accredited"] is True
        authz = client.post(
            "/api/v1/immo/owner-authorisations",
            headers=_auth(token),
            json={"vin": SANDBOX_VIN},
        )
        # Owner authorisation also requires a verified workshop.
        assert authz.status_code == 403
        assert "AASRA" in authz.json()["detail"]


def test_start_denied_when_technician_not_accredited(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    token = sess["access_token"]
    _mark_aasra(client, token)
    with flags(immo=True, dev_login=True):
        # Stale police check: enrol records paperwork but must not accredit.
        enrol = client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(token),
            json={
                "aasra_member_id": "VSP-TEST-1",
                "national_police_check_dated": (date.today() - timedelta(days=365 * 3)).isoformat(),
                "declared": True,
            },
        )
        assert enrol.status_code == 200, enrol.text
        assert enrol.json()["accredited"] is False
        assert enrol.json()["vsp_status"] == "pending"
        authz = client.post(
            "/api/v1/immo/owner-authorisations",
            headers=_auth(token),
            json={"vin": SANDBOX_VIN},
        )
        assert authz.status_code == 403
        assert "not accredited" in authz.json()["detail"].lower()


def test_start_denied_without_owner_authorisation_or_vin_mismatch(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    token = sess["access_token"]
    _mark_aasra(client, token)
    with flags(immo=True):
        enrol = client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(token),
            json={
                "aasra_member_id": "VSP-TEST-1",
                "national_police_check_dated": date.today().isoformat(),
                "declared": True,
            },
        )
        assert enrol.json()["accredited"] is True
        missing = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": SANDBOX_VIN,
                "authorisation_id": str(uuid.uuid4()),
                "oem": SANDBOX_OEM,
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": SANDBOX_DEVICE_TIER,
            },
        )
        assert missing.status_code == 403
        authz = client.post(
            "/api/v1/immo/owner-authorisations",
            headers=_auth(token),
            json={"vin": SANDBOX_VIN},
        )
        assert authz.status_code == 200, authz.text
        mismatch = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": "1HGCM82633A004352",
                "authorisation_id": authz.json()["id"],
                "oem": SANDBOX_OEM,
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": SANDBOX_DEVICE_TIER,
            },
        )
        assert mismatch.status_code == 403
        assert "does not match" in mismatch.json()["detail"]


def test_start_denied_for_unknown_oem_or_vci_tier(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    token = sess["access_token"]
    _mark_aasra(client, token)
    with flags(immo=True):
        client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(token),
            json={
                "aasra_member_id": "VSP-TEST-1",
                "national_police_check_dated": date.today().isoformat(),
                "declared": True,
            },
        )
        authz = client.post(
            "/api/v1/immo/owner-authorisations",
            headers=_auth(token),
            json={"vin": SANDBOX_VIN},
        )
        assert authz.status_code == 200
        aid = authz.json()["id"]
        unknown = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": SANDBOX_VIN,
                "authorisation_id": aid,
                "oem": "FORD",
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": SANDBOX_DEVICE_TIER,
            },
        )
        assert unknown.status_code == 403
        assert "allow-list" in unknown.json()["detail"]
        vci = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": SANDBOX_VIN,
                "authorisation_id": aid,
                "oem": SANDBOX_OEM,
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": "vci",
            },
        )
        assert vci.status_code == 403


def test_client_cannot_force_aasra_or_accredit_via_body(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    token = sess["access_token"]
    with flags(immo=True):
        res = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": SANDBOX_VIN,
                "authorisation_id": str(uuid.uuid4()),
                "oem": SANDBOX_OEM,
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": SANDBOX_DEVICE_TIER,
                "aasra_verified": True,
                "tenant_id": "t_attacker",
                "user_id": "u_attacker",
            },
        )
    assert res.status_code == 403


def _ready_job(client: TestClient) -> tuple[str, dict]:
    sess = _dev_session(client)
    token = sess["access_token"]
    _mark_aasra(client, token)
    with flags(immo=True):
        enrol = client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(token),
            json={
                "aasra_member_id": "VSP-TEST-1",
                "national_police_check_dated": date.today().isoformat(),
                "declared": True,
            },
        )
        assert enrol.status_code == 200 and enrol.json()["accredited"]
        authz = client.post(
            "/api/v1/immo/owner-authorisations",
            headers=_auth(token),
            json={"vin": SANDBOX_VIN},
        )
        assert authz.status_code == 200, authz.text
        started = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": SANDBOX_VIN,
                "authorisation_id": authz.json()["id"],
                "oem": SANDBOX_OEM,
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": SANDBOX_DEVICE_TIER,
            },
        )
        assert started.status_code == 200, started.text
        return token, started.json()


def test_happy_path_and_concurrent_and_token_and_complete(client: TestClient):
    _require_db()
    with flags(immo=True):
        token, job = _ready_job(client)
        lease = job["lease"]
        assert lease["lease_kind"] == "immo_lease"
        assert lease["features"] == ["IMMO_PROGRAM"]
        assert "vin" not in lease
        sid = job["session_id"]

        # Concurrent session on the same VIN/device is refused.
        # Need a second authorisation first (same VIN).
        authz2 = client.post(
            "/api/v1/immo/owner-authorisations",
            headers=_auth(token),
            json={"vin": SANDBOX_VIN},
        )
        conflict = client.post(
            "/api/v1/immo/sessions",
            headers=_auth(token),
            json={
                "vin": SANDBOX_VIN,
                "authorisation_id": authz2.json()["id"],
                "oem": SANDBOX_OEM,
                "operation": SANDBOX_OPERATION,
                "device_id": SANDBOX_DEVICE_ID,
                "device_tier": SANDBOX_DEVICE_TIER,
            },
        )
        assert conflict.status_code == 409

        tok = client.post(f"/api/v1/immo/sessions/{sid}/token", headers=_auth(token))
        assert tok.status_code == 200, tok.text
        body = tok.json()
        assert body["payload_hex"] == SANDBOX_KEY_HEX
        assert "pin" not in body["description"].lower()

        done = client.post(f"/api/v1/immo/sessions/{sid}/complete", headers=_auth(token))
        assert done.status_code == 200 and done.json()["status"] == "completed"
        again = client.post(f"/api/v1/immo/sessions/{sid}/complete", headers=_auth(token))
        assert again.status_code == 409
        abort = client.post(f"/api/v1/immo/sessions/{sid}/abort", headers=_auth(token))
        assert abort.status_code == 409


def test_sandbox_token_fails_closed_without_dev_login(client: TestClient):
    _require_db()
    with flags(immo=True, dev_login=True):
        token, job = _ready_job(client)
        sid = job["session_id"]
    with flags(immo=True, dev_login=False):
        tok = client.post(f"/api/v1/immo/sessions/{sid}/token", headers=_auth(token))
    assert tok.status_code == 503
    assert (
        "AUTH_ALLOW_DEV_LOGIN" in tok.json()["detail"] or "not configured" in tok.json()["detail"]
    )


def test_abort_then_cannot_fetch_token(client: TestClient):
    _require_db()
    with flags(immo=True):
        token, job = _ready_job(client)
        sid = job["session_id"]
        aborted = client.post(f"/api/v1/immo/sessions/{sid}/abort", headers=_auth(token))
        assert aborted.status_code == 200 and aborted.json()["status"] == "aborted"
        tok = client.post(f"/api/v1/immo/sessions/{sid}/token", headers=_auth(token))
        assert tok.status_code == 409


def test_eligibility_reports_each_gate_and_profiles_follow_the_flag(client: TestClient):
    _require_db()
    sess = _dev_session(client)
    token = sess["access_token"]
    with flags(immo=False):
        res = client.get("/api/v1/immo/eligibility", headers=_auth(token))
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["ready"] is False
        assert body["checks"] == {
            "feature_enabled": False,
            "plan": False,
            "addon": False,
            "aasra": False,
            "technician": False,
        }
        assert body["technician"]["status"] == "not_enrolled"
        assert client.get("/api/v1/immo/profiles", headers=_auth(token)).status_code == 403

    _mark_aasra(client, token)
    with flags(immo=True):
        enrol = client.post(
            "/api/v1/immo/technicians/enrol",
            headers=_auth(token),
            json={
                "aasra_member_id": "VSP-ELIG-1",
                "national_police_check_dated": date.today().isoformat(),
                "declared": True,
            },
        )
        assert enrol.status_code == 200, enrol.text
        body = client.get("/api/v1/immo/eligibility", headers=_auth(token)).json()
        assert body["ready"] is True, body
        assert body["technician"]["status"] == "accredited"
        assert body["technician"]["aasra_member_id"] == "VSP-ELIG-1"
        profiles = client.get("/api/v1/immo/profiles", headers=_auth(token)).json()
        assert [p["oem"] for p in profiles["profiles"]] == [SANDBOX_OEM]
        assert profiles["min_battery_v"] == 13.0
