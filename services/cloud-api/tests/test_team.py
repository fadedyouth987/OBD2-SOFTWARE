"""Team management: seat and site caps, invites (hash-only tokens), roles, RLS."""

from __future__ import annotations

import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.api.v1.team import hash_token, invite_state  # noqa: E402
from app.main import app  # noqa: E402

PASSWORD = "correct horse battery"


@pytest.fixture
def client():
    from app.config import get_settings

    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT token_hash FROM tenant_invites LIMIT 0"))
        engine.dispose()
    except Exception:  # noqa: BLE001 - no Postgres, or not migrated to 006
        pytest.skip("needs Postgres migrated to 006")
    return TestClient(app)


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


def _grant(client: TestClient, token: str, tier: str) -> None:
    res = client.post("/api/v1/auth/dev-grant-plan", json={"tier": tier}, headers=_auth(token))
    assert res.status_code == 200, res.text


# --- pure helpers -------------------------------------------------------------


def test_hash_token_is_sha256_hex():
    h = hash_token("abc")
    assert len(h) == 64 and h == hash_token("abc") and h != hash_token("abd")


def test_invite_state_order():
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    base = {"accepted_at": None, "revoked_at": None, "expires_at": now + timedelta(days=1)}
    assert invite_state(base, now) == "open"
    assert invite_state({**base, "expires_at": now - timedelta(seconds=1)}, now) == "expired"
    assert invite_state({**base, "revoked_at": now}, now) == "revoked"
    assert invite_state({**base, "accepted_at": now, "revoked_at": now}, now) == "used"


# --- API ----------------------------------------------------------------------


def test_new_workshop_has_main_site_and_one_seat(client):
    owner = _signup(client)
    team = client.get("/api/v1/team", headers=_auth(owner["access_token"])).json()
    assert team["can_manage"] is True
    assert team["seats"] == {"used": 1, "pending": 0, "limit": 1}
    assert [s["name"] for s in team["sites"]] == ["Main site"]
    assert team["members"][0]["role"] == "OWNER" and team["members"][0]["you"] is True


def test_community_cannot_invite_past_one_seat(client):
    owner = _signup(client)
    res = client.post(
        "/api/v1/team/invites", json={"email": _email("tech")}, headers=_auth(owner["access_token"])
    )
    assert res.status_code == 402
    assert "1 seat" in res.json()["detail"]


def test_invite_signup_join_and_seat_cap(client):
    owner = _signup(client)
    tok = owner["access_token"]
    _grant(client, tok, "WORKSHOP")  # 5 seats
    invited = _email("tech")
    res = client.post(
        "/api/v1/team/invites", json={"email": invited, "role": "TECH"}, headers=_auth(tok)
    )
    assert res.status_code == 201, res.text
    body = res.json()
    token = body["token"]
    assert body["invite_url"].endswith(f"/join?token={token}")
    # Only the hash is stored.
    from app.config import get_settings

    eng = create_engine(get_settings().migration_database_url)
    with eng.connect() as c:
        stored = c.execute(
            text("SELECT token_hash FROM tenant_invites WHERE email = :e"), {"e": invited}
        ).scalar_one()
    eng.dispose()
    assert stored == hash_token(token) and token not in stored

    # A second invite for the same email is refused while the first is open.
    dup = client.post("/api/v1/team/invites", json={"email": invited}, headers=_auth(tok))
    assert dup.status_code == 409

    look = client.get("/api/v1/team/invites/lookup", params={"token": token}).json()
    assert look["email"] == invited and look["state"] == "open" and look["role"] == "TECH"

    # Wrong email can't use the link.
    wrong = client.post(
        "/api/v1/auth/signup",
        json={"email": _email("other"), "password": PASSWORD, "invite_token": token},
    )
    assert wrong.status_code == 403

    joined = _signup(client, email=invited, invite_token=token)
    assert joined["tenant_id"] == owner["tenant_id"]
    assert [w["role"] for w in joined["workspaces"]] == ["TECH"]
    me = client.get("/api/v1/auth/me", headers=_auth(joined["access_token"])).json()
    assert me["workspace"]["tenant_id"] == owner["tenant_id"]

    # The link is single-use.
    again = client.post(
        "/api/v1/auth/signup",
        json={"email": _email("x"), "password": PASSWORD, "invite_token": token},
    )
    assert again.status_code == 410

    team = client.get("/api/v1/team", headers=_auth(tok)).json()
    assert team["seats"]["used"] == 2 and team["seats"]["pending"] == 0

    # A tech can see the team but not manage it.
    tech_view = client.get("/api/v1/team", headers=_auth(joined["access_token"])).json()
    assert tech_view["can_manage"] is False
    forbidden = client.post(
        "/api/v1/team/invites", json={"email": _email("y")}, headers=_auth(joined["access_token"])
    )
    assert forbidden.status_code == 403

    # Fill the remaining 3 seats with invites, then the 6th is refused.
    for _ in range(3):
        r = client.post("/api/v1/team/invites", json={"email": _email("t")}, headers=_auth(tok))
        assert r.status_code == 201, r.text
    full = client.post("/api/v1/team/invites", json={"email": _email("t")}, headers=_auth(tok))
    assert full.status_code == 402

    # Revoking frees the seat.
    pending = client.get("/api/v1/team", headers=_auth(tok)).json()["invites"]
    assert (
        client.delete(f"/api/v1/team/invites/{pending[0]['id']}", headers=_auth(tok)).status_code
        == 204
    )
    ok = client.post("/api/v1/team/invites", json={"email": _email("t")}, headers=_auth(tok))
    assert ok.status_code == 201


def test_existing_user_accepts_invite_and_role_changes(client):
    owner = _signup(client)
    tok = owner["access_token"]
    _grant(client, tok, "PRO")  # 1 seat: an invite has nowhere to go
    assert (
        client.post(
            "/api/v1/team/invites", json={"email": _email("a")}, headers=_auth(tok)
        ).status_code
        == 402
    )
    _grant(client, tok, "FLEET")
    other_email = _email("lead")
    other = _signup(client, email=other_email)  # has their own workshop already
    inv = client.post(
        "/api/v1/team/invites", json={"email": other_email, "role": "LEAD_TECH"}, headers=_auth(tok)
    ).json()
    res = client.post(
        "/api/v1/team/invites/accept",
        json={"token": inv["token"]},
        headers=_auth(other["access_token"]),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["tenant_id"] == owner["tenant_id"]
    assert len(body["workspaces"]) == 2

    uid = other["user_id"]
    patched = client.patch(f"/api/v1/team/members/{uid}", json={"role": "TECH"}, headers=_auth(tok))
    assert patched.status_code == 200 and patched.json()["role"] == "TECH"
    own = client.patch(
        f"/api/v1/team/members/{owner['user_id']}", json={"role": "TECH"}, headers=_auth(tok)
    )
    assert own.status_code == 409
    assert (
        client.delete(f"/api/v1/team/members/{owner['user_id']}", headers=_auth(tok)).status_code
        == 409
    )
    assert client.delete(f"/api/v1/team/members/{uid}", headers=_auth(tok)).status_code == 204
    # They still have their own workshop.
    assert client.get("/api/v1/auth/me", headers=_auth(other["access_token"])).status_code == 200


def test_site_caps_and_rules(client):
    owner = _signup(client)
    tok = owner["access_token"]
    assert (
        client.post("/api/v1/team/sites", json={"name": "Second"}, headers=_auth(tok)).status_code
        == 402
    )
    _grant(client, tok, "FLEET")  # 3 sites
    a = client.post("/api/v1/team/sites", json={"name": "  North   yard "}, headers=_auth(tok))
    assert a.status_code == 201 and a.json()["name"] == "North yard"
    assert (
        client.post(
            "/api/v1/team/sites", json={"name": "north YARD"}, headers=_auth(tok)
        ).status_code
        == 409
    )
    assert (
        client.post("/api/v1/team/sites", json={"name": "South"}, headers=_auth(tok)).status_code
        == 201
    )
    assert (
        client.post("/api/v1/team/sites", json={"name": "East"}, headers=_auth(tok)).status_code
        == 402
    )
    sid = a.json()["id"]
    assert (
        client.patch(
            f"/api/v1/team/sites/{sid}", json={"name": "Depot"}, headers=_auth(tok)
        ).status_code
        == 200
    )
    me_uid = owner["user_id"]
    moved = client.patch(
        f"/api/v1/team/members/{me_uid}", json={"site_id": sid}, headers=_auth(tok)
    )
    assert moved.status_code == 200 and moved.json()["site_id"] == sid
    assert client.delete(f"/api/v1/team/sites/{sid}", headers=_auth(tok)).status_code == 204
    team = client.get("/api/v1/team", headers=_auth(tok)).json()
    assert len(team["sites"]) == 2 and team["members"][0]["site_id"] is None
    for s in team["sites"][1:]:
        assert client.delete(f"/api/v1/team/sites/{s['id']}", headers=_auth(tok)).status_code == 204
    last = client.get("/api/v1/team", headers=_auth(tok)).json()["sites"][0]["id"]
    assert client.delete(f"/api/v1/team/sites/{last}", headers=_auth(tok)).status_code == 409


def test_team_is_tenant_isolated(client):
    a = _signup(client)
    b = _signup(client)
    _grant(client, a["access_token"], "WORKSHOP")
    inv = client.post(
        "/api/v1/team/invites", json={"email": _email("iso")}, headers=_auth(a["access_token"])
    ).json()
    # B can't revoke A's invite or see A's members.
    r = client.delete(
        f"/api/v1/team/invites/{inv['invite']['id']}", headers=_auth(b["access_token"])
    )
    assert r.status_code == 404  # RLS hides A's invite from B entirely
    still = client.get("/api/v1/team", headers=_auth(a["access_token"])).json()["invites"]
    assert [i["id"] for i in still] == [inv["invite"]["id"]]
    _grant(client, b["access_token"], "WORKSHOP")
    team_b = client.get("/api/v1/team", headers=_auth(b["access_token"])).json()
    assert all(m["user_id"] != a["user_id"] for m in team_b["members"])
    assert team_b["invites"] == []
