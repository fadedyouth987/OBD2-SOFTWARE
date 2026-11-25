"""Licensed OEM procedures: strict import checks, versioning, matching, admin API."""

from __future__ import annotations

import copy
import io
import json
import os
import uuid
from datetime import date, timedelta

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.config import get_settings  # noqa: E402
from app.db.vin import model_year  # noqa: E402
from app.main import app  # noqa: E402
from app.services import accreditation, procedures  # noqa: E402

PASSWORD = "correct horse battery"


@pytest.fixture
def client():
    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT status FROM procedure_records LIMIT 0"))
        engine.dispose()
    except Exception:  # noqa: BLE001
        pytest.skip("needs Postgres migrated to 010")
    return TestClient(app)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _signup(client: TestClient, tag: str = "u") -> dict:
    email = f"{tag}-{uuid.uuid4().hex[:10]}@example.com"
    res = client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    return {**res.json(), "email": email}


def _doc(key: str, model: str, **over) -> dict:
    proc = {
        "function_id": "oil_reset",
        "make": "Testmake",
        "model": model,
        "year_from": 2015,
        "year_to": 2019,
        "source_ref": "TM-OIL-1",
        "module": "IC",
        "tx_id": "0x720",
        "rx_id": "0x728",
        "service": "RoutineControl",
        "identifier": "0x0501",
        "start_hex": "31 01 05 01",
        "expected_seconds": 5,
        "notes": "Ignition on, engine off.",
    }
    proc.update(over)
    return {
        "format": procedures.FORMAT,
        "source": {
            "key": key,
            "name": f"Licensed test data {key}",
            "licence": "Test licence: internal test data only.",
        },
        "procedures": [proc],
    }


def _key() -> str:
    return f"test-{uuid.uuid4().hex[:8]}"


@pytest.mark.parametrize(
    "over",
    [
        {"start_hex": "27 01"},  # SecurityAccess
        {"start_hex": "2E F1 90 00"},  # write
        {"start_hex": "31 01 05 02"},  # different routine from identifier
        {"stop_hex": "31 03 05 01"},
        {"service": "WriteDataByIdentifier"},
        {"enter_session_hex": "1002"},  # programming session
        {"exit_session_hex": "1003"},
        {"function_id": "made_up"},
        {"year_from": 2020, "year_to": 2010},
        {"expected_seconds": 0},
        {"service": "InputOutputControlByIdentifier", "start_hex": "2F 05 01 00"},
        {
            "service": "InputOutputControlByIdentifier",
            "start_hex": "2F 05 01 03 01",
            "stop_hex": "11 01",
        },
        {"tx_id": "0x2FFFFFFF"},
        {"start_hex": "zz"},
    ],
)
def test_unsafe_or_malformed_procedures_are_refused(over):
    with pytest.raises(HTTPException) as exc:
        procedures.parse_document(_doc("x-key", "M", **over))
    assert exc.value.status_code == 422
    assert exc.value.detail["errors"]


def test_whole_document_rejected_and_format_checked():
    doc = _doc("x-key", "M")
    doc["procedures"].append({**doc["procedures"][0], "source_ref": "B", "start_hex": "2701"})
    with pytest.raises(HTTPException):
        procedures.parse_document(doc)
    bad = _doc("x-key", "M")
    bad["format"] = "something/v2"
    with pytest.raises(HTTPException):
        procedures.parse_document(bad)
    dup = _doc("x-key", "M")
    dup["procedures"].append(copy.deepcopy(dup["procedures"][0]))
    with pytest.raises(HTTPException) as exc:
        procedures.parse_document(dup)
    assert "repeated" in json.dumps(exc.value.detail)


def test_io_control_shape_is_allowed():
    doc = procedures.parse_document(
        _doc(
            "x-key",
            "M",
            function_id="abs_bleed",
            service="InputOutputControlByIdentifier",
            identifier="0x4A10",
            start_hex="2F4A100301",
            stop_hex="2F4A1000",
        )
    )
    run = doc.procedures[0].runnable()
    assert run["tx_id"] == 0x720 and run["stop_hex"] == "2F4A1000"
    assert run["stop_needs_confirmation"] is False


def test_vin_model_year():
    assert model_year("6FPAAAJGSJA123456", latest=2027) == 2018
    assert model_year("6FPAAAJGS1A123456", latest=2027) == 2001
    assert model_year("6FPAAAJGSTA123456", latest=2027) == 2026
    assert model_year("6FPAAAJGS0A123456", latest=2027) is None


def test_import_versions_and_withdraws(client):
    key, model = _key(), f"Model {uuid.uuid4().hex[:6]}"
    first = procedures.import_document(_doc(key, model), imported_by=None)
    assert first == {"source": key, "created": 1, "updated": 0, "unchanged": 0, "withdrawn": 0}
    again = procedures.import_document(_doc(key, model), imported_by=None)
    assert again["unchanged"] == 1
    changed = procedures.import_document(_doc(key, model, expected_seconds=9), imported_by=None)
    assert changed["updated"] == 1
    other = _doc(
        key,
        model,
        source_ref="TM-SAS-1",
        function_id="sas_cal",
        identifier="0x0601",
        start_hex="31010601",
    )
    other["replace"] = True
    replaced = procedures.import_document(other, imported_by=None)
    assert replaced["created"] == 1 and replaced["withdrawn"] == 1

    engine = create_engine(get_settings().database_url)
    with engine.connect() as c:
        rows = c.execute(
            text(
                "SELECT r.source_ref, r.version, r.status FROM procedure_records r "
                "JOIN procedure_sources s ON s.id = r.source_id WHERE s.key = :k "
                "ORDER BY r.source_ref, r.version"
            ),
            {"k": key},
        ).all()
    engine.dispose()
    assert [tuple(r) for r in rows] == [
        ("TM-OIL-1", 1, "SUPERSEDED"),
        ("TM-OIL-1", 2, "WITHDRAWN"),
        ("TM-SAS-1", 1, "ACTIVE"),
    ]


def test_licensed_lookup_matches_vehicle_and_respects_licence_expiry(client):
    key, model = _key(), f"Model {uuid.uuid4().hex[:6]}"
    procedures.import_document(_doc(key, model), imported_by=None)
    v = procedures.Vehicle(make="TESTMAKE", model=model.lower(), year=2017)
    sf = procedures.LicensedCatalogueProvider().lookup(adapter_id=None, vehicle=v)
    assert sf["oil_reset"].availability == "licensed"
    assert sf["oil_reset"].source["licence"].startswith("Test licence")
    assert sf["oil_reset"].procedure["start_hex"] == "31010501"
    assert (
        procedures.LicensedCatalogueProvider().lookup(
            adapter_id=None, vehicle=procedures.Vehicle("Testmake", model, 2021)
        )
        == {}
    )

    expired = _doc(key, model)
    expired["source"]["licensed_until"] = (date.today() - timedelta(days=1)).isoformat()
    procedures.import_document(expired, imported_by=None)
    assert procedures.LicensedCatalogueProvider().lookup(adapter_id=None, vehicle=v) == {}


def test_service_functions_api_uses_job_vehicle(client):
    key, model = _key(), f"Model {uuid.uuid4().hex[:6]}"
    procedures.import_document(_doc(key, model), imported_by=None)
    user = _signup(client)
    h = _auth(user["access_token"])
    job = client.post(
        "/api/v1/jobs",
        json={"vehicle_make": "Testmake", "vehicle_model": model, "model_year": 2016},
        headers=h,
    )
    assert job.status_code == 201, job.text
    jid = job.json()["id"]
    res = client.get(f"/api/v1/service-functions?job_id={jid}", headers=h)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["source"] == "licensed"
    oil = next(f for f in body["functions"] if f["id"] == "oil_reset")
    assert oil["availability"] == "licensed" and oil["source"]["source_ref"] == "TM-OIL-1"
    sas = next(f for f in body["functions"] if f["id"] == "sas_cal")
    assert sas["availability"] == "no_verified_procedure" and sas["procedure"] is None

    # Different year: honest "no verified procedure".
    client.patch(f"/api/v1/jobs/{jid}", json={"model_year": 2005}, headers=h)
    body = client.get(f"/api/v1/service-functions?job_id={jid}", headers=h).json()
    assert body["source"] == "none"
    assert all(f["availability"] == "no_verified_procedure" for f in body["functions"])
    assert "No verified OEM procedures" in body["note"]

    # Virtual adapter keeps the simulator procedures regardless of the job.
    client.patch(f"/api/v1/jobs/{jid}", json={"model_year": 2016}, headers=h)
    sim = client.get(
        f"/api/v1/service-functions?job_id={jid}&adapter_id=virtual-ford-falcon-ba", headers=h
    ).json()
    assert sim["source"] == "simulator"
    assert all(f["availability"] != "licensed" for f in sim["functions"])
    bare = client.get(
        f"/api/v1/service-functions?job_id={jid}&adapter_id=virtual-no-such", headers=h
    ).json()
    assert bare["source"] == "none"

    other = _signup(client)
    assert (
        client.get(
            f"/api/v1/service-functions?job_id={jid}", headers=_auth(other["access_token"])
        ).status_code
        == 404
    )


def test_job_vehicle_identity_from_vin(client):
    user = _signup(client)
    h = _auth(user["access_token"])
    job = client.post("/api/v1/jobs", json={"vin": "6FPAAAJGSTA123456"}, headers=h).json()
    assert job["vehicle_make"] == "Ford Australia"
    assert job["model_year"] == 2026
    fixed = client.patch(
        f"/api/v1/jobs/{job['id']}",
        json={"vehicle_model": "  Falcon   BA ", "model_year": 2003},
        headers=h,
    ).json()
    assert fixed["vehicle_model"] == "Falcon BA" and fixed["model_year"] == 2003


def test_admin_procedure_endpoints(client):
    tech = _signup(client, "tech")
    assert (
        client.get("/api/v1/admin/procedures", headers=_auth(tech["access_token"])).status_code
        == 403
    )
    admin = _signup(client, "admin")
    assert accreditation.set_platform_admin(admin["email"], True)
    a = _auth(admin["access_token"])
    key, model = _key(), f"Model {uuid.uuid4().hex[:6]}"
    up = client.post(
        "/api/v1/admin/procedures/import",
        files={
            "file": (
                "p.json",
                io.BytesIO(json.dumps(_doc(key, model)).encode()),
                "application/json",
            )
        },
        headers=a,
    )
    assert up.status_code == 200, up.text
    assert up.json()["created"] == 1
    bad = client.post(
        "/api/v1/admin/procedures/import",
        files={
            "file": (
                "p.json",
                io.BytesIO(json.dumps(_doc(key, model, start_hex="2701")).encode()),
                "application/json",
            )
        },
        headers=a,
    )
    assert bad.status_code == 422
    assert bad.json()["detail"]["errors"]
    notjson = client.post(
        "/api/v1/admin/procedures/import",
        files={"file": ("p.json", b"nope", "application/json")},
        headers=a,
    )
    assert notjson.status_code == 422

    cat = client.get("/api/v1/admin/procedures", headers=a).json()
    src = next(s for s in cat["sources"] if s["key"] == key)
    assert src["active_procedures"] == 1
    rec = next(r for r in cat["recent"] if r["source"] == src["name"])
    assert (
        client.post(f"/api/v1/admin/procedures/{rec['id']}/withdraw", headers=a).status_code == 200
    )
    assert (
        client.post(f"/api/v1/admin/procedures/{rec['id']}/withdraw", headers=a).status_code == 404
    )
    # No feed configured in tests.
    assert client.post("/api/v1/admin/procedures/sync", headers=a).status_code == 409


def test_feed_sync_uses_bearer_key_and_replaces(client, monkeypatch):
    key, model = _key(), f"Model {uuid.uuid4().hex[:6]}"
    monkeypatch.setenv("PROCEDURE_PROVIDER_FEED_URL", "https://feed.example.com/v1/procedures")
    monkeypatch.setenv("PROCEDURE_PROVIDER_API_KEY", "test-key-not-real")
    get_settings.cache_clear()
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=_doc(key, model))

    try:
        out = procedures.sync_from_provider(
            imported_by=None, client=httpx.Client(transport=httpx.MockTransport(handler))
        )
        assert seen["auth"] == "Bearer test-key-not-real"
        assert out["created"] == 1

        def failing(request):
            return httpx.Response(401, json={})

        with pytest.raises(HTTPException) as exc:
            procedures.sync_from_provider(
                imported_by=None, client=httpx.Client(transport=httpx.MockTransport(failing))
            )
        assert exc.value.status_code == 502
    finally:
        get_settings.cache_clear()
