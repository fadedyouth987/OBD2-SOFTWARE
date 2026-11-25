"""Lead-tech permissions, job ownership, ownership hand-over, team audit, invite email."""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.db.models import MembershipRole  # noqa: E402
from app.main import app  # noqa: E402
from app.services import email as email_service  # noqa: E402
from app.services.permissions import Permission, permissions_for  # noqa: E402

PASSWORD = "correct horse battery"


class Recorder:
    name = "recorder"

    def __init__(self) -> None:
        self.sent: list[email_service.OutgoingEmail] = []

    def send(self, message, *, sender, reply_to):
        self.sent.append(message)
        return f"rec-{len(self.sent)}"


@pytest.fixture
def client():
    from app.config import get_settings

    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT status FROM ownership_transfers LIMIT 0"))
        engine.dispose()
    except Exception:  # noqa: BLE001 - no Postgres, or not migrated to 008
        pytest.skip("needs Postgres migrated to 008")
    return TestClient(app)


@pytest.fixture
def outbox():
    rec = Recorder()
    email_service.set_provider_for_tests(rec)
    yield rec
    email_service.set_provider_for_tests(None)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _email(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:10]}@example.com"


def _signup(client: TestClient, email: str | None = None, **extra) -> dict:
    res = client.post(
        "/api/v1/auth/signup",
        json={"email": email or _email("owner"), "password": PASSWORD, **extra},
    )
    assert res.status_code == 201, res.text
    return res.json()


def _workshop(client: TestClient, outbox: Recorder) -> dict:
    """Owner on Workshop (5 seats) with a lead tech and a tech who joined by email link."""
    owner = _signup(client, workshop_name="Bradley Auto")
    tok = owner["access_token"]
    res = client.post("/api/v1/auth/dev-grant-plan", json={"tier": "WORKSHOP"}, headers=_auth(tok))
    assert res.status_code == 200
    people = {"owner": owner}
    for role, tag in (("LEAD_TECH", "lead"), ("TECH", "tech")):
        addr = _email(tag)
        inv = client.post(
            "/api/v1/team/invites", json={"email": addr, "role": role}, headers=_auth(tok)
        )
        assert inv.status_code == 201, inv.text
        assert inv.json()["email"] == {"sent": True, "provider": "recorder"}
        people[tag] = _signup(client, email=addr, invite_token=inv.json()["token"])
    return people


# --- pure ---------------------------------------------------------------------------


def test_role_matrix():
    owner = permissions_for(MembershipRole.OWNER)
    lead = permissions_for(MembershipRole.LEAD_TECH)
    tech = permissions_for(MembershipRole.TECH)
    assert owner == frozenset(Permission)
    assert Permission.MANAGE_ALL_JOBS in lead and Permission.INVITE_MEMBERS in lead
    for denied in (
        Permission.MANAGE_BILLING,
        Permission.TRANSFER_OWNERSHIP,
        Permission.MANAGE_ROLES,
        Permission.REMOVE_MEMBERS,
        Permission.MANAGE_SITES,
        Permission.INVITE_LEAD_TECHS,
    ):
        assert denied not in lead
    assert tech == frozenset()


# --- invites by email ---------------------------------------------------------------


def test_invite_is_emailed_with_the_join_link(client, outbox):
    people = _workshop(client, outbox)
    first = outbox.sent[0]
    assert first.subject == "You're invited to Bradley Auto on RootCause OBD"
    assert "/join?token=" in first.text and "Lead tech" in first.text
    assert "/join?token=" in first.html
    me = client.get("/api/v1/auth/me", headers=_auth(people["lead"]["access_token"])).json()
    assert me["workspace"]["role"] == "LEAD_TECH"
    assert "manage_all_jobs" in me["workspace"]["permissions"]
    assert "manage_billing" not in me["workspace"]["permissions"]


def test_invite_without_email_falls_back_to_copy_link(client):
    email_service.set_provider_for_tests(None)
    owner = _signup(client)
    tok = owner["access_token"]
    client.post("/api/v1/auth/dev-grant-plan", json={"tier": "WORKSHOP"}, headers=_auth(tok))
    res = client.post("/api/v1/team/invites", json={"email": _email("t")}, headers=_auth(tok))
    assert res.status_code == 201
    body = res.json()
    assert body["email"]["sent"] is False and body["invite_url"].startswith("http")
    assert client.get("/api/v1/team", headers=_auth(tok)).json()["email_enabled"] is False


def test_resend_rotates_the_link(client, outbox):
    owner = _signup(client)
    tok = owner["access_token"]
    client.post("/api/v1/auth/dev-grant-plan", json={"tier": "WORKSHOP"}, headers=_auth(tok))
    inv = client.post("/api/v1/team/invites", json={"email": _email("t")}, headers=_auth(tok))
    old = inv.json()["token"]
    again = client.post(
        f"/api/v1/team/invites/{inv.json()['invite']['id']}/resend", headers=_auth(tok)
    )
    assert again.status_code == 200
    new = again.json()["token"]
    assert new != old and len(outbox.sent) == 2
    assert client.get("/api/v1/team/invites/lookup", params={"token": old}).status_code == 404
    look = client.get("/api/v1/team/invites/lookup", params={"token": new}).json()
    assert look["state"] == "open"


def test_failed_email_still_creates_the_invite(client):
    class Broken:
        name = "broken"

        def send(self, message, *, sender, reply_to):
            raise email_service.EmailError("boom")

    email_service.set_provider_for_tests(Broken())
    try:
        owner = _signup(client)
        tok = owner["access_token"]
        client.post("/api/v1/auth/dev-grant-plan", json={"tier": "WORKSHOP"}, headers=_auth(tok))
        res = client.post("/api/v1/team/invites", json={"email": _email("t")}, headers=_auth(tok))
        assert res.status_code == 201
        assert res.json()["email"] == {
            "sent": False,
            "provider": "broken",
            "error": "The email couldn't be sent",
        }
    finally:
        email_service.set_provider_for_tests(None)


# --- lead tech ----------------------------------------------------------------------


def test_lead_tech_invites_techs_but_not_leads_or_billing(client, outbox):
    people = _workshop(client, outbox)
    lead = _auth(people["lead"]["access_token"])
    ok = client.post("/api/v1/team/invites", json={"email": _email("t2")}, headers=lead)
    assert ok.status_code == 201
    assert (
        client.post(
            "/api/v1/team/invites", json={"email": _email("l2"), "role": "LEAD_TECH"}, headers=lead
        ).status_code
        == 403
    )
    assert (
        client.delete(f"/api/v1/team/invites/{ok.json()['invite']['id']}", headers=lead).status_code
        == 204
    )
    team = client.get("/api/v1/team", headers=lead).json()
    assert team["abilities"]["invite"] is True and team["abilities"]["invite_roles"] == ["TECH"]
    assert team["abilities"]["change_roles"] is False and team["abilities"]["manage_sites"] is False
    tech_id = people["tech"]["user_id"]
    assert (
        client.patch(
            f"/api/v1/team/members/{tech_id}", json={"role": "LEAD_TECH"}, headers=lead
        ).status_code
        == 403
    )
    assert client.delete(f"/api/v1/team/members/{tech_id}", headers=lead).status_code == 403
    assert (
        client.post("/api/v1/team/sites", json={"name": "North"}, headers=lead).status_code == 403
    )
    portal = client.post("/api/v1/billing/customer-portal", json={}, headers=lead)
    assert portal.status_code == 403
    assert (
        client.post(
            "/api/v1/team/ownership-transfer",
            json={"to_user_id": tech_id, "confirm_name": "Bradley Auto"},
            headers=lead,
        ).status_code
        == 403
    )


def test_tech_sees_no_invites_and_cannot_invite(client, outbox):
    people = _workshop(client, outbox)
    tech = _auth(people["tech"]["access_token"])
    team = client.get("/api/v1/team", headers=tech).json()
    assert team["invites"] == [] and team["history"] == []
    assert team["abilities"]["invite"] is False
    assert (
        client.post("/api/v1/team/invites", json={"email": _email("x")}, headers=tech).status_code
        == 403
    )


def test_jobs_belong_to_their_technician_unless_lead_or_owner(client, outbox):
    people = _workshop(client, outbox)
    tech = _auth(people["tech"]["access_token"])
    lead = _auth(people["lead"]["access_token"])
    owner = _auth(people["owner"]["access_token"])
    job = client.post("/api/v1/jobs", json={"vehicle_label": "Falcon"}, headers=owner).json()
    assert job["can_edit"] is True
    # A tech can read the owner's job but not change or close it.
    seen = client.get(f"/api/v1/jobs/{job['id']}", headers=tech).json()
    assert seen["can_edit"] is False and seen["technician_name"]
    assert (
        client.patch(f"/api/v1/jobs/{job['id']}", json={"complaint": "x"}, headers=tech).status_code
        == 403
    )
    close = {"summary": "Done here", "actual_fix": "Replaced it"}
    assert (
        client.post(f"/api/v1/jobs/{job['id']}/close", json=close, headers=tech).status_code == 403
    )
    # A tech can't reassign; a lead can, to a team member only.
    assign = {"user_id": people["tech"]["user_id"]}
    assert (
        client.post(f"/api/v1/jobs/{job['id']}/assign", json=assign, headers=tech).status_code
        == 403
    )
    stranger = {"user_id": str(uuid.uuid4())}
    assert (
        client.post(f"/api/v1/jobs/{job['id']}/assign", json=stranger, headers=lead).status_code
        == 422
    )
    moved = client.post(f"/api/v1/jobs/{job['id']}/assign", json=assign, headers=lead)
    assert moved.status_code == 200 and moved.json()["user_id"] == people["tech"]["user_id"]
    # Now it's the tech's job.
    assert (
        client.patch(
            f"/api/v1/jobs/{job['id']}", json={"complaint": "rough idle"}, headers=tech
        ).status_code
        == 200
    )
    # The lead can still close anyone's job.
    assert (
        client.post(f"/api/v1/jobs/{job['id']}/close", json=close, headers=lead).status_code == 200
    )


# --- ownership ----------------------------------------------------------------------


def test_ownership_hand_over_needs_both_sides(client, outbox):
    people = _workshop(client, outbox)
    owner = _auth(people["owner"]["access_token"])
    lead = _auth(people["lead"]["access_token"])
    tech = _auth(people["tech"]["access_token"])
    tech_id = people["tech"]["user_id"]
    wrong = client.post(
        "/api/v1/team/ownership-transfer",
        json={"to_user_id": tech_id, "confirm_name": "Bradley"},
        headers=owner,
    )
    assert wrong.status_code == 422
    offer = client.post(
        "/api/v1/team/ownership-transfer",
        json={"to_user_id": tech_id, "confirm_name": "  bradley   auto "},
        headers=owner,
    )
    assert offer.status_code == 201, offer.text
    offer_id = offer.json()["id"]
    assert outbox.sent[-1].subject == "Ownership of Bradley Auto on RootCause OBD"
    # Nothing changes until the tech accepts; only the tech can accept.
    assert client.get("/api/v1/auth/me", headers=owner).json()["workspace"]["role"] == "OWNER"
    assert (
        client.post(f"/api/v1/team/ownership-transfer/{offer_id}/accept", headers=lead).status_code
        == 403
    )
    dup = client.post(
        "/api/v1/team/ownership-transfer",
        json={"to_user_id": people["lead"]["user_id"], "confirm_name": "Bradley Auto"},
        headers=owner,
    )
    assert dup.status_code == 409
    pending = client.get("/api/v1/team", headers=tech).json()["ownership_transfer"]
    assert pending["for_you"] is True and pending["id"] == offer_id
    accepted = client.post(f"/api/v1/team/ownership-transfer/{offer_id}/accept", headers=tech)
    assert accepted.status_code == 200
    assert client.get("/api/v1/auth/me", headers=tech).json()["workspace"]["role"] == "OWNER"
    assert client.get("/api/v1/auth/me", headers=owner).json()["workspace"]["role"] == "LEAD_TECH"
    # Single-use.
    assert (
        client.post(f"/api/v1/team/ownership-transfer/{offer_id}/accept", headers=tech).status_code
        == 410
    )
    history = client.get("/api/v1/team", headers=tech).json()["history"]
    actions = [h["action"] for h in history]
    assert actions[:2] == ["ownership_transferred", "ownership_offered"]
    assert "invite_accepted" in actions and "invite_created" in actions


def test_ownership_offer_can_be_declined_or_cancelled(client, outbox):
    people = _workshop(client, outbox)
    owner = _auth(people["owner"]["access_token"])
    lead = _auth(people["lead"]["access_token"])
    body = {"to_user_id": people["lead"]["user_id"], "confirm_name": "Bradley Auto"}
    first = client.post("/api/v1/team/ownership-transfer", json=body, headers=owner).json()
    assert (
        client.post(
            f"/api/v1/team/ownership-transfer/{first['id']}/decline", headers=lead
        ).status_code
        == 200
    )
    second = client.post("/api/v1/team/ownership-transfer", json=body, headers=owner).json()
    assert client.delete("/api/v1/team/ownership-transfer", headers=owner).status_code == 204
    assert (
        client.post(
            f"/api/v1/team/ownership-transfer/{second['id']}/accept", headers=lead
        ).status_code
        == 410
    )
    assert client.get("/api/v1/auth/me", headers=owner).json()["workspace"]["role"] == "OWNER"
    actions = [h["action"] for h in client.get("/api/v1/team", headers=owner).json()["history"]]
    assert actions[:4] == [
        "ownership_offer_cancelled",
        "ownership_offered",
        "ownership_offer_declined",
        "ownership_offered",
    ]


def test_expired_offer_cannot_be_accepted(client, outbox):
    from app.config import get_settings

    people = _workshop(client, outbox)
    owner = _auth(people["owner"]["access_token"])
    body = {"to_user_id": people["tech"]["user_id"], "confirm_name": "Bradley Auto"}
    offer = client.post("/api/v1/team/ownership-transfer", json=body, headers=owner).json()
    eng = create_engine(get_settings().migration_database_url)
    with eng.begin() as c:
        c.execute(
            text(
                "UPDATE ownership_transfers SET expires_at = now() - interval '1 minute' "
                "WHERE id = :i"
            ),
            {"i": offer["id"]},
        )
    eng.dispose()
    tech = _auth(people["tech"]["access_token"])
    assert (
        client.post(
            f"/api/v1/team/ownership-transfer/{offer['id']}/accept", headers=tech
        ).status_code
        == 410
    )
    # The owner can make a fresh offer once the old one has lapsed.
    assert (
        client.post("/api/v1/team/ownership-transfer", json=body, headers=owner).status_code == 201
    )


def test_team_audit_is_tenant_isolated(client, outbox):
    people = _workshop(client, outbox)
    other = _signup(client)
    hist = client.get("/api/v1/team", headers=_auth(other["access_token"])).json()["history"]
    assert all(h["subject"] != people["lead"].get("email") for h in hist)
    assert [h["action"] for h in hist] == []
