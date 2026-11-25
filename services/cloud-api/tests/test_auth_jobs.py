"""Password sign-in, /auth/me and the diagnostic session (job) workflow."""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("VIN_HMAC_KEY_REF", "env://VIN_HMAC_KEY")
os.environ.setdefault("VIN_HMAC_KEY", "test-only-vin-hmac-key-0123456789")

from app.main import app  # noqa: E402
from app.services.identity import (  # noqa: E402
    IdentityError,
    check_password_policy,
    hash_password,
    normalize_email,
    verify_password,
)

PASSWORD = "correct horse battery"


@pytest.fixture
def client():
    return TestClient(app)


def _require_db() -> None:
    from app.config import get_settings

    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT password_hash FROM users LIMIT 0"))
        engine.dispose()
    except Exception:  # noqa: BLE001 - OperationalError or a missing 005 column
        pytest.skip("needs Postgres migrated to 005")


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _signup(client: TestClient, **extra) -> tuple[str, dict]:
    email = f"tech-{uuid.uuid4().hex[:10]}@example.com"
    res = client.post(
        "/api/v1/auth/signup",
        json={"email": email, "password": PASSWORD, "workshop_name": "Test Auto", **extra},
    )
    assert res.status_code == 201, res.text
    return email, res.json()


# --- pure helpers -------------------------------------------------------------


def test_password_hash_round_trip_and_rejects_wrong():
    stored = hash_password(PASSWORD)
    assert stored.startswith("scrypt$")
    assert PASSWORD not in stored
    assert verify_password(PASSWORD, stored)
    assert not verify_password("correct horse batterz", stored)
    assert not verify_password(PASSWORD, None)
    assert not verify_password(PASSWORD, "garbage")


def test_password_policy_and_email_normalisation():
    with pytest.raises(IdentityError):
        check_password_policy("short")
    with pytest.raises(IdentityError):
        check_password_policy("aaaaaaaaaaaa")
    check_password_policy(PASSWORD)
    assert normalize_email("  Jack@Example.COM ") == "jack@example.com"
    with pytest.raises(IdentityError):
        normalize_email("not-an-email")


def test_me_and_jobs_need_a_session(client: TestClient):
    for method, path in (
        ("get", "/api/v1/auth/me"),
        ("get", "/api/v1/jobs"),
        ("post", "/api/v1/jobs"),
    ):
        res = getattr(client, method)(path, **({"json": {}} if method == "post" else {}))
        assert res.status_code == 401, (path, res.status_code)


# --- database-backed ----------------------------------------------------------


def test_signup_login_me_and_workspace_list(client: TestClient):
    _require_db()
    email, body = _signup(client, display_name="Jack")
    me = client.get("/api/v1/auth/me", headers=_auth(body["access_token"]))
    assert me.status_code == 200, me.text
    data = me.json()
    assert data["user"]["email"] == email
    assert data["workspace"]["role"] == "OWNER"
    assert data["workspace"]["name"] == "Test Auto"
    assert data["entitlements"]["tier"] == "COMMUNITY"
    assert data["usage"]["ai_diagnoses_used"] == 0
    assert len(data["workspaces"]) == 1

    dup = client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD})
    assert dup.status_code == 409

    ok = client.post("/api/v1/auth/login", json={"email": email.upper(), "password": PASSWORD})
    assert ok.status_code == 200, ok.text
    assert ok.json()["tenant_id"] == body["tenant_id"]


def test_login_does_not_reveal_which_part_failed_and_locks_out(client: TestClient):
    _require_db()
    email, _ = _signup(client)
    unknown = client.post(
        "/api/v1/auth/login", json={"email": "nobody-x@example.com", "password": PASSWORD}
    )
    wrong = client.post("/api/v1/auth/login", json={"email": email, "password": "wrong-password"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json()["detail"] == wrong.json()["detail"]
    for _ in range(4):
        client.post("/api/v1/auth/login", json={"email": email, "password": "wrong-password"})
    locked = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
    assert locked.status_code == 423


def test_job_lifecycle_and_report(client: TestClient):
    _require_db()
    _, body = _signup(client)
    h = _auth(body["access_token"])
    start = client.post(
        "/api/v1/jobs",
        headers=h,
        json={
            "edge_session_id": f"sess_{uuid.uuid4().hex[:12]}",
            "vin": "6FPAAAJGSW8B12345",
            "vehicle_label": "Ford Falcon BA",
            "adapter_id": "virtual-ford-falcon-ba",
            "lease_tier": "COMMUNITY",
        },
    )
    assert start.status_code == 201, start.text
    job = start.json()
    assert job["status"] == "OPEN"
    assert job["vin_redacted"] == "6FPAAAJGS" + "•" * 8
    assert "6FPAAAJGSW8B12345" not in start.text

    again = client.post("/api/v1/jobs", headers=h, json={"edge_session_id": job["edge_session_id"]})
    assert again.json()["id"] == job["id"], "re-attaching to the same daemon session"

    bad = client.patch(f"/api/v1/jobs/{job['id']}", headers=h, json={"dtcs": [{"code": "X1"}]})
    assert bad.status_code == 422

    upd = client.patch(
        f"/api/v1/jobs/{job['id']}",
        headers=h,
        json={
            "dtcs": [
                {"code": "p0171", "module": "PCM", "status": "confirmed", "source": "OBD 03"},
                {"code": "P0171", "module": "PCM", "status": "confirmed", "source": "OBD 03"},
                {"code": "C1145", "module": "ABS", "status": "confirmed", "source": "UDS 19"},
            ],
            "alerts": [
                {
                    "rule_id": "audit.consistent",
                    "severity": "INFO",
                    "title": "VIN and odometer agree across 3 modules",
                }
            ],
        },
    )
    assert upd.status_code == 200, upd.text
    assert [d["code"] for d in upd.json()["dtcs"]] == ["P0171", "C1145"]

    listed = client.get("/api/v1/jobs?status=OPEN", headers=h).json()
    assert listed["open"] == 1 and listed["jobs"][0]["id"] == job["id"]

    closed = client.post(
        f"/api/v1/jobs/{job['id']}/close",
        headers=h,
        json={
            "summary": "Lean bank 1 at idle",
            "actual_fix": "Replaced split PCV hose",
            "parts_replaced": ["PCV hose", " "],
            "publish_case": True,
        },
    )
    assert closed.status_code == 200, closed.text
    out = closed.json()
    assert out["status"] == "CLOSED"
    assert out["closeout"]["parts_replaced"] == ["PCV hose"]
    assert out["closeout"]["case_id"]

    again_close = client.post(
        f"/api/v1/jobs/{job['id']}/close",
        headers=h,
        json={"summary": "x" * 5, "actual_fix": "y" * 5},
    )
    assert again_close.status_code == 409
    frozen = client.patch(f"/api/v1/jobs/{job['id']}", headers=h, json={"complaint": "late"})
    assert frozen.status_code == 409

    report = client.get(f"/api/v1/jobs/{job['id']}/report", headers=h)
    assert report.status_code == 200, report.text
    rep = report.json()
    assert rep["workshop"]["name"] == "Test Auto"
    assert rep["job"]["closeout"]["actual_fix"] == "Replaced split PCV hose"


def test_jobs_are_tenant_isolated(client: TestClient):
    _require_db()
    _, a = _signup(client)
    _, b = _signup(client)
    job = client.post("/api/v1/jobs", headers=_auth(a["access_token"]), json={}).json()
    other = client.get(f"/api/v1/jobs/{job['id']}", headers=_auth(b["access_token"]))
    assert other.status_code == 404
    assert client.get("/api/v1/jobs", headers=_auth(b["access_token"])).json()["jobs"] == []


def test_publish_case_needs_dtcs(client: TestClient):
    _require_db()
    _, body = _signup(client)
    h = _auth(body["access_token"])
    job = client.post("/api/v1/jobs", headers=h, json={}).json()
    res = client.post(
        f"/api/v1/jobs/{job['id']}/close",
        headers=h,
        json={"summary": "No codes", "actual_fix": "Nothing", "publish_case": True},
    )
    assert res.status_code == 422


def test_attach_device_session_once_and_scrub_alert_evidence(client: TestClient):
    _require_db()
    _, body = _signup(client)
    h = _auth(body["access_token"])
    job = client.post("/api/v1/jobs", headers=h, json={"vehicle_label": "Walk-in"}).json()
    assert job["edge_session_id"] is None
    edge = f"sess_{uuid.uuid4().hex[:12]}"
    first = client.patch(f"/api/v1/jobs/{job['id']}", headers=h, json={"edge_session_id": edge})
    assert first.status_code == 200 and first.json()["edge_session_id"] == edge
    # Set once: a later daemon session does not move the job's telemetry.
    second = client.patch(
        f"/api/v1/jobs/{job['id']}", headers=h, json={"edge_session_id": "sess_other_1"}
    )
    assert second.json()["edge_session_id"] == edge
    # Another job cannot claim a device session that is already attached.
    other = client.post("/api/v1/jobs", headers=h, json={}).json()
    clash = client.patch(f"/api/v1/jobs/{other['id']}", headers=h, json={"edge_session_id": edge})
    assert clash.status_code == 409

    vin = "6FPAAAJGSW8B12345"
    upd = client.patch(
        f"/api/v1/jobs/{job['id']}",
        headers=h,
        json={
            "alerts": [
                {
                    "rule_id": "audit.vin_mismatch",
                    "severity": "RED",
                    "title": "VIN differs between modules",
                    "evidence_json": {"PCM": vin, "IC": {"vin": vin}},
                }
            ]
        },
    )
    assert upd.status_code == 200, upd.text
    assert vin not in upd.text
    assert upd.json()["alerts"][0]["evidence_json"]["IC"]["vin"] == "[VIN_REDACTED]"


def test_service_functions_only_offer_procedures_on_file(client: TestClient):
    _require_db()
    _, body = _signup(client)
    h = _auth(body["access_token"])
    assert client.get("/api/v1/service-functions").status_code in (401, 403)

    sim = client.get(
        "/api/v1/service-functions?adapter_id=virtual-ford-falcon-ba", headers=h
    ).json()
    assert sim["source"] == "simulator"
    by_id = {f["id"]: f for f in sim["functions"]}
    assert len(by_id) == 11
    oil = by_id["oil_reset"]
    assert oil["availability"] == "simulated"
    assert oil["procedure"]["start_hex"] == "31010501"
    assert (oil["procedure"]["tx_id"], oil["procedure"]["rx_id"]) == (0x720, 0x728)
    assert oil["checklist"], "every function has a technician checklist"
    assert by_id["abs_bleed"]["procedure"]["stop_hex"] == "1001"
    assert by_id["injector_coding"]["availability"] == "no_verified_procedure"
    # Nothing in any procedure uses SecurityAccess (0x27).
    for f in sim["functions"]:
        proc = f["procedure"] or {}
        for key in ("enter_session_hex", "start_hex", "stop_hex", "exit_session_hex"):
            assert not str(proc.get(key) or "").startswith("27")

    real = client.get("/api/v1/service-functions?adapter_id=serial-ttyUSB0", headers=h).json()
    assert real["source"] == "none"
    assert all(f["procedure"] is None for f in real["functions"])

    assert client.get("/api/v1/vehicles/not_a_profile/services").status_code == 404
