"""AASRA accreditation reviewed by a platform admin: submit, approve/reject, expiry, audit."""

from __future__ import annotations

import os
import uuid
from datetime import date, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services import accreditation  # noqa: E402
from app.services import email as email_service  # noqa: E402

PASSWORD = "correct horse battery"
PDF = b"%PDF-1.4\n% evidence\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class Recorder:
    name = "recorder"

    def __init__(self) -> None:
        self.sent: list = []

    def send(self, message, *, sender, reply_to):
        self.sent.append(message)
        return "id"


@pytest.fixture
def client(monkeypatch):
    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT status FROM accreditation_requests LIMIT 0"))
        engine.dispose()
    except Exception:  # noqa: BLE001
        pytest.skip("needs Postgres migrated to 009")
    monkeypatch.setenv("AASRA_DEV_AUTO_APPROVE", "false")
    return TestClient(app)


@pytest.fixture
def outbox():
    rec = Recorder()
    email_service.set_provider_for_tests(rec)
    yield rec
    email_service.set_provider_for_tests(None)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _signup(client: TestClient, tag: str = "u") -> dict:
    email = f"{tag}-{uuid.uuid4().hex[:10]}@example.com"
    res = client.post("/api/v1/auth/signup", json={"email": email, "password": PASSWORD})
    assert res.status_code == 201, res.text
    return {**res.json(), "email": email}


def _admin(client: TestClient) -> dict:
    admin = _signup(client, "admin")
    assert accreditation.set_platform_admin(admin["email"], True)
    return admin


def _submit_tech(client, tok, *, police: date | None = None, files=None):
    police = police or date.today() - timedelta(days=60)
    return client.post(
        "/api/v1/accreditation/technician",
        data={
            "aasra_member_id": "AASRA-12345",
            "national_police_check_dated": police.isoformat(),
            "declared": "true",
        },
        files=files
        if files is not None
        else [("evidence", ("membership.pdf", PDF, "application/pdf"))],
        headers=_auth(tok),
    )


def _sql(stmt: str, **params) -> None:
    eng = create_engine(get_settings().migration_database_url)
    with eng.begin() as c:
        c.execute(text(stmt), params)
    eng.dispose()


# --- pure ---------------------------------------------------------------------------


def test_abn_checksum():
    assert accreditation.normalize_abn("51 824 753 556") == "51824753556"
    with pytest.raises(HTTPException):
        accreditation.normalize_abn("51 824 753 557")
    with pytest.raises(HTTPException):
        accreditation.normalize_abn("1234")


def test_dev_auto_approve_needs_both_flags(monkeypatch):
    monkeypatch.setenv("AASRA_DEV_AUTO_APPROVE", "true")
    monkeypatch.setenv("AUTH_ALLOW_DEV_LOGIN", "false")
    assert accreditation.dev_auto_approve() is False
    monkeypatch.setenv("AUTH_ALLOW_DEV_LOGIN", "true")
    assert accreditation.dev_auto_approve() is True
    monkeypatch.setenv("AASRA_DEV_AUTO_APPROVE", "false")
    assert accreditation.dev_auto_approve() is False


# --- technician ---------------------------------------------------------------------


def test_submission_needs_evidence_and_stays_pending(client, outbox):
    tech = _signup(client, "tech")
    tok = tech["access_token"]
    none = _submit_tech(client, tok, files=[])
    assert none.status_code == 422 and "evidence" in none.json()["detail"].lower()
    bad = _submit_tech(client, tok, files=[("evidence", ("x.pdf", b"<html>", "application/pdf"))])
    assert bad.status_code == 415
    stale = _submit_tech(client, tok, police=date.today() - timedelta(days=800))
    assert stale.status_code == 422
    ok = _submit_tech(client, tok)
    assert ok.status_code == 201, ok.text
    body = ok.json()["technician"]
    assert (
        body["state"] == "pending"
        and body["pending"]["evidence"][0]["filename"] == "membership.pdf"
    )
    # Dev login alone doesn't approve anything.
    tech_row = client.get("/api/v1/immo/eligibility", headers=_auth(tok)).json()["technician"]
    assert tech_row["status"] == "pending"
    # The technician can open their own evidence; someone else can't.
    ev = body["pending"]["evidence"][0]["id"]
    assert client.get(f"/api/v1/accreditation/evidence/{ev}", headers=_auth(tok)).content == PDF
    other = _signup(client, "other")
    assert (
        client.get(
            f"/api/v1/accreditation/evidence/{ev}", headers=_auth(other["access_token"])
        ).status_code
        == 404
    )


def test_only_platform_admins_review(client, outbox):
    tech = _signup(client, "tech")
    assert _submit_tech(client, tech["access_token"]).status_code == 201
    assert (
        client.get("/api/v1/admin/accreditations", headers=_auth(tech["access_token"])).status_code
        == 403
    )
    me = client.get("/api/v1/auth/me", headers=_auth(tech["access_token"])).json()
    assert me["platform_admin"] is False


def test_admin_approves_with_expiry_capped_by_paperwork(client, outbox):
    tech = _signup(client, "tech")
    police = date.today() - timedelta(days=700)  # runs out in about 30 days
    rid = _submit_tech(client, tech["access_token"], police=police).json()["technician"]["pending"][
        "id"
    ]
    admin = _admin(client)
    a = _auth(admin["access_token"])
    assert client.get("/api/v1/auth/me", headers=a).json()["platform_admin"] is True
    queue = client.get("/api/v1/admin/accreditations", headers=a).json()["items"]
    item = next(i for i in queue if i["id"] == rid)
    assert item["subject_email"] == tech["email"] and item["kind"] == "TECHNICIAN"
    assert item["events"][0]["event"] == "submitted"
    ev = item["evidence"][0]["id"]
    assert client.get(f"/api/v1/admin/accreditations/{rid}/evidence/{ev}", headers=a).content == PDF
    too_long = (date.today() + timedelta(days=200)).isoformat()
    capped = client.post(
        f"/api/v1/admin/accreditations/{rid}/approve", json={"expires_on": too_long}, headers=a
    )
    assert capped.status_code == 422 and "runs out on" in capped.json()["detail"]
    past = client.post(
        f"/api/v1/admin/accreditations/{rid}/approve",
        json={"expires_on": date.today().isoformat()},
        headers=a,
    )
    assert past.status_code == 422
    ok_day = (date.today() + timedelta(days=20)).isoformat()
    ok = client.post(
        f"/api/v1/admin/accreditations/{rid}/approve", json={"expires_on": ok_day}, headers=a
    )
    assert ok.status_code == 200, ok.text
    status = client.get("/api/v1/accreditation", headers=_auth(tech["access_token"])).json()
    assert status["technician"]["state"] == "approved"
    tech_row = client.get("/api/v1/immo/eligibility", headers=_auth(tech["access_token"])).json()
    assert tech_row["technician"]["status"] == "accredited"
    assert outbox.sent[-1].subject.startswith("Technician accreditation approved")
    again = client.post(f"/api/v1/admin/accreditations/{rid}/approve", json={}, headers=a)
    assert again.status_code == 409


def test_admin_cannot_review_their_own(client, outbox):
    admin = _admin(client)
    rid = _submit_tech(client, admin["access_token"]).json()["technician"]["pending"]["id"]
    res = client.post(
        f"/api/v1/admin/accreditations/{rid}/approve", json={}, headers=_auth(admin["access_token"])
    )
    assert res.status_code == 403


def test_reject_needs_a_reason_and_emails_it(client, outbox):
    tech = _signup(client, "tech")
    rid = _submit_tech(client, tech["access_token"]).json()["technician"]["pending"]["id"]
    a = _auth(_admin(client)["access_token"])
    short = client.post(
        f"/api/v1/admin/accreditations/{rid}/reject", json={"reason": "no"}, headers=a
    )
    assert short.status_code == 422
    reason = "The membership letter is for a different business name"
    res = client.post(
        f"/api/v1/admin/accreditations/{rid}/reject", json={"reason": reason}, headers=a
    )
    assert res.status_code == 200
    status = client.get("/api/v1/accreditation", headers=_auth(tech["access_token"])).json()[
        "technician"
    ]
    assert status["state"] == "rejected" and status["latest"]["decision_reason"] == reason
    assert reason in outbox.sent[-1].text
    # They can fix it and submit again.
    assert _submit_tech(client, tech["access_token"]).json()["technician"]["state"] == "pending"


def test_resubmitting_supersedes_and_renewal_keeps_access(client, outbox):
    tech = _signup(client, "tech")
    tok = tech["access_token"]
    first = _submit_tech(client, tok).json()["technician"]["pending"]["id"]
    second = _submit_tech(client, tok).json()["technician"]["pending"]["id"]
    assert first != second
    a = _auth(_admin(client)["access_token"])
    queue = client.get("/api/v1/admin/accreditations", headers=a).json()["items"]
    assert first not in [i["id"] for i in queue] and second in [i["id"] for i in queue]
    client.post(f"/api/v1/admin/accreditations/{second}/approve", json={}, headers=a)
    # Renewing while approved: still accredited while the renewal waits for review.
    assert _submit_tech(client, tok).json()["technician"]["state"] == "renewal_pending"
    elig = client.get("/api/v1/immo/eligibility", headers=_auth(tok)).json()
    assert elig["technician"]["status"] == "accredited"


def test_revoke_removes_access(client, outbox):
    tech = _signup(client, "tech")
    rid = _submit_tech(client, tech["access_token"]).json()["technician"]["pending"]["id"]
    a = _auth(_admin(client)["access_token"])
    client.post(f"/api/v1/admin/accreditations/{rid}/approve", json={}, headers=a)
    res = client.post(
        f"/api/v1/admin/accreditations/{rid}/revoke",
        json={"reason": "Membership cancelled by AASRA on request"},
        headers=a,
    )
    assert res.status_code == 200
    elig = client.get("/api/v1/immo/eligibility", headers=_auth(tech["access_token"])).json()
    assert elig["technician"]["status"] != "accredited"
    events = client.get("/api/v1/admin/accreditations?status=REVOKED", headers=a).json()["items"]
    item = next(i for i in events if i["id"] == rid)
    assert [e["event"] for e in item["events"]] == ["submitted", "approved", "revoked"]


def test_reminders_then_lapse(client, outbox):
    tech = _signup(client, "tech")
    rid = _submit_tech(client, tech["access_token"]).json()["technician"]["pending"]["id"]
    a = _auth(_admin(client)["access_token"])
    client.post(f"/api/v1/admin/accreditations/{rid}/approve", json={}, headers=a)
    _sql(
        "UPDATE accreditation_requests SET expires_at = now() + interval '6 days 2 hours' "
        "WHERE id = :i",
        i=rid,
    )
    before = len(outbox.sent)
    first = accreditation.run_reminders()
    mine = [m for m in outbox.sent[before:] if m.to == tech["email"]]
    assert first["reminded"] >= 1 and len(mine) == 1
    assert "lapses in 6 days" in mine[0].subject
    # Both the 30- and 7-day reminders are now recorded: no repeat.
    before = len(outbox.sent)
    accreditation.run_reminders()
    assert [m for m in outbox.sent[before:] if m.to == tech["email"]] == []
    _sql(
        "UPDATE accreditation_requests SET expires_at = now() - interval '1 minute' WHERE id = :i",
        i=rid,
    )
    lapsed = accreditation.run_reminders()
    assert lapsed["expired"] >= 1
    assert any(m.to == tech["email"] and "lapsed" in m.subject for m in outbox.sent)
    status = client.get("/api/v1/accreditation", headers=_auth(tech["access_token"])).json()
    assert status["technician"]["state"] == "expired"
    elig = client.get("/api/v1/immo/eligibility", headers=_auth(tech["access_token"])).json()
    assert elig["technician"]["status"] != "accredited"


# --- workshop -----------------------------------------------------------------------


def test_workshop_accreditation_by_owner_with_expiry(client, outbox):
    owner = _signup(client, "owner")
    tok = owner["access_token"]
    form = {"aasra_member_id": "AASRA-BIZ-9", "business_abn": "51 824 753 557", "declared": "true"}
    files = [("evidence", ("letter.png", PNG, "image/png"))]
    bad = client.post("/api/v1/accreditation/workshop", data=form, files=files, headers=_auth(tok))
    assert bad.status_code == 422 and "ABN" in bad.json()["detail"]
    form["business_abn"] = "51 824 753 556"
    res = client.post("/api/v1/accreditation/workshop", data=form, files=files, headers=_auth(tok))
    assert res.status_code == 201, res.text
    rid = res.json()["workshop"]["pending"]["id"]
    assert (
        client.get("/api/v1/auth/me", headers=_auth(tok)).json()["workspace"]["aasra_verified"]
        is False
    )
    a = _auth(_admin(client)["access_token"])
    client.post(f"/api/v1/admin/accreditations/{rid}/approve", json={}, headers=a)
    assert (
        client.get("/api/v1/auth/me", headers=_auth(tok)).json()["workspace"]["aasra_verified"]
        is True
    )
    _sql(
        "UPDATE tenants SET aasra_verified_until = now() - interval '1 second' WHERE id = :t",
        t=owner["tenant_id"],
    )
    assert (
        client.get("/api/v1/auth/me", headers=_auth(tok)).json()["workspace"]["aasra_verified"]
        is False
    )


def test_requests_are_tenant_isolated(client, outbox):
    one = _signup(client, "one")
    _submit_tech(client, one["access_token"])
    two = _signup(client, "two")
    status = client.get("/api/v1/accreditation", headers=_auth(two["access_token"])).json()
    assert status["technician"]["state"] == "not_submitted"
    assert status["workshop"]["state"] == "not_submitted"
