"""Schematic and DBC uploads: content checks, page quota, tenant isolation, storage."""

from __future__ import annotations

import io
import os
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)

from app.api.v1.dbc import message_count  # noqa: E402
from app.api.v1.schematics import count_pages, sniff_type  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402
from app.services.object_store import key_belongs_to, object_key  # noqa: E402

PASSWORD = "correct horse battery"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
DBC = (
    b'VERSION ""\n\nBO_ 513 ENGINE_DATA: 8 PCM\n'
    b' SG_ RPM : 0|16@1+ (0.25,0) [0|16383] "rpm" Vector__XXX\n'
)


def _pdf(pages: int) -> bytes:
    from pypdf import PdfWriter

    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=200, height=200)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()


# --- pure helpers -------------------------------------------------------------


def test_sniff_type_uses_content_not_name():
    assert sniff_type(b"%PDF-1.7 ...") == "application/pdf"
    assert sniff_type(PNG) == "image/png"
    assert sniff_type(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
    assert sniff_type(b"<html>") is None


def test_count_pages():
    assert count_pages(_pdf(3), "application/pdf") == 3
    assert count_pages(PNG, "image/png") == 1
    with pytest.raises(Exception, match="couldn't be read|422"):
        count_pages(b"%PDF-1.4 garbage", "application/pdf")


def test_dbc_message_count():
    assert message_count(DBC.decode()) == 1
    assert message_count("just text") == 0


def test_object_keys_are_tenant_scoped():
    t, o = uuid.uuid4(), uuid.uuid4()
    k = object_key("schematics", t, o, "pdf")
    assert k == f"schematics/{t}/{o}.pdf"
    assert key_belongs_to(k, t) and not key_belongs_to(k, uuid.uuid4())
    with pytest.raises(ValueError):
        object_key("../etc", t, o, "pdf")


# --- API (needs Postgres at 007 and the S3 stand-in) ---------------------------


@pytest.fixture
def client():
    from app.config import get_settings
    from app.services import object_store

    try:
        engine = create_engine(get_settings().database_url)
        with engine.connect() as c:
            c.execute(text("SELECT sha256, uploaded_by FROM wiring_schematics LIMIT 0"))
        engine.dispose()
        object_store._client().head_bucket(Bucket=get_settings().s3_bucket)
    except Exception:  # noqa: BLE001 - no Postgres/S3, or not migrated to 007
        pytest.skip("needs Postgres migrated to 007 and S3")
    return TestClient(app)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _owner(client: TestClient, tier: str | None = None) -> dict:
    res = client.post(
        "/api/v1/auth/signup",
        json={"email": f"files-{uuid.uuid4().hex[:10]}@example.com", "password": PASSWORD},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    if tier:
        g = client.post(
            "/api/v1/auth/dev-grant-plan", json={"tier": tier}, headers=_auth(body["access_token"])
        )
        assert g.status_code == 200, g.text
    return body


def test_community_cannot_upload_schematics(client):
    o = _owner(client)
    res = client.post(
        "/api/v1/schematics",
        files={"file": ("w.pdf", _pdf(1), "application/pdf")},
        headers=_auth(o["access_token"]),
    )
    assert res.status_code == 402


def test_schematic_upload_charges_pages_and_streams_back(client):
    o = _owner(client, "PRO")  # 25 pages a month
    tok = o["access_token"]
    pdf = _pdf(3)
    res = client.post(
        "/api/v1/schematics",
        files={"file": ("loom.pdf", pdf, "application/pdf")},
        data={"title": "Engine loom", "vehicle_profile": "ford-falcon-ba"},
        headers=_auth(tok),
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["schematic"]["page_count"] == 3 and body["pages_used"] == 3
    sid = body["schematic"]["id"]
    me = client.get("/api/v1/auth/me", headers=_auth(tok)).json()
    assert me["usage"]["schematic_pages_used"] == 3

    got = client.get(f"/api/v1/schematics/{sid}/file", headers=_auth(tok))
    assert got.status_code == 200 and got.content == pdf
    assert got.headers["content-type"] == "application/pdf"
    assert "no-store" in got.headers["cache-control"]

    listed = client.get(
        "/api/v1/schematics", params={"vehicle_profile": "ford-falcon-ba"}, headers=_auth(tok)
    ).json()
    assert [i["id"] for i in listed["items"]] == [sid]

    # A renamed non-PDF is refused by content.
    bad = client.post(
        "/api/v1/schematics",
        files={"file": ("fake.pdf", b"<html>hi</html>", "application/pdf")},
        headers=_auth(tok),
    )
    assert bad.status_code == 415

    # Over the allowance: refused, nothing charged, nothing kept.
    big = client.post(
        "/api/v1/schematics",
        files={"file": ("big.pdf", _pdf(23), "application/pdf")},
        headers=_auth(tok),
    )
    assert big.status_code == 402 and "22 of 25" in big.json()["detail"]
    after = client.get("/api/v1/schematics", headers=_auth(tok)).json()["items"]
    assert len(after) == 1
    me = client.get("/api/v1/auth/me", headers=_auth(tok)).json()
    assert me["usage"]["schematic_pages_used"] == 3

    # Another workshop can't read or delete it.
    other = _owner(client, "PRO")
    assert (
        client.get(
            f"/api/v1/schematics/{sid}/file", headers=_auth(other["access_token"])
        ).status_code
        == 404
    )
    assert (
        client.delete(f"/api/v1/schematics/{sid}", headers=_auth(other["access_token"])).status_code
        == 404
    )
    assert listed["items"][0]["refundable_pages"] == 3
    deleted = client.delete(f"/api/v1/schematics/{sid}", headers=_auth(tok))
    assert deleted.status_code == 200, deleted.text
    # Deleted in the same quota month: the 3 pages come back.
    assert deleted.json() == {"refunded_pages": 3, "pages_used": 0, "pages_limit": 25}
    assert client.get(f"/api/v1/schematics/{sid}/file", headers=_auth(tok)).status_code == 404
    me = client.get("/api/v1/auth/me", headers=_auth(tok)).json()
    assert me["usage"]["schematic_pages_used"] == 0


def test_schematic_from_an_earlier_month_is_not_refunded(client):
    o = _owner(client, "PRO")
    tok = o["access_token"]
    res = client.post(
        "/api/v1/schematics",
        files={"file": ("loom.pdf", _pdf(4), "application/pdf")},
        headers=_auth(tok),
    )
    assert res.status_code == 201, res.text
    sid = res.json()["schematic"]["id"]
    engine = create_engine(get_settings().migration_database_url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE wiring_schematics SET charged_period = charged_period - interval '1 month'"
                " WHERE id = :id"
            ),
            {"id": sid},
        )
    engine.dispose()
    listed = client.get("/api/v1/schematics", headers=_auth(tok)).json()
    assert listed["items"][0]["refundable_pages"] == 0
    deleted = client.delete(f"/api/v1/schematics/{sid}", headers=_auth(tok)).json()
    assert deleted["refunded_pages"] == 0 and deleted["pages_used"] == 4


def test_refund_never_takes_usage_below_zero(client):
    from app.db.session import tenant_session
    from app.services.billing import current_quota_period, refund_schematic_pages

    o = _owner(client, "PRO")
    tenant_id = uuid.UUID(o["tenant_id"])
    with tenant_session(tenant_id) as session:
        session.execute(
            text(
                "UPDATE tenants SET schematic_pages_used = 2, ai_quota_period_start = :p "
                "WHERE id = :id"
            ),
            {"p": current_quota_period(), "id": tenant_id},
        )
        assert refund_schematic_pages(session, tenant_id, 5, current_quota_period()) == 5
        used = session.execute(
            text("SELECT schematic_pages_used FROM tenants WHERE id = :id"), {"id": tenant_id}
        ).scalar_one()
        assert used == 0
        assert refund_schematic_pages(session, tenant_id, 5, None) == 0


def test_dbc_storage_is_can_studio_only_and_round_trips(client):
    pro = _owner(client, "PRO")
    assert (
        client.post(
            "/api/v1/dbc",
            files={"file": ("a.dbc", DBC, "text/plain")},
            headers=_auth(pro["access_token"]),
        ).status_code
        == 402
    )
    ws = _owner(client, "WORKSHOP")
    tok = ws["access_token"]
    notdbc = client.post(
        "/api/v1/dbc", files={"file": ("x.dbc", b"hello", "text/plain")}, headers=_auth(tok)
    )
    assert notdbc.status_code == 422
    res = client.post(
        "/api/v1/dbc",
        files={"file": ("falcon.dbc", DBC, "text/plain")},
        data={"vehicle_profile": "ford-falcon-ba"},
        headers=_auth(tok),
    )
    assert res.status_code == 201, res.text
    item = res.json()["dbc"]
    assert item["message_count"] == 1 and item["name"] == "falcon.dbc"
    dup = client.post(
        "/api/v1/dbc", files={"file": ("copy.dbc", DBC, "text/plain")}, headers=_auth(tok)
    )
    assert dup.status_code == 409
    got = client.get(f"/api/v1/dbc/{item['id']}/file", headers=_auth(tok))
    assert got.status_code == 200 and got.content == DBC
    assert [i["id"] for i in client.get("/api/v1/dbc", headers=_auth(tok)).json()["items"]] == [
        item["id"]
    ]
    assert client.delete(f"/api/v1/dbc/{item['id']}", headers=_auth(tok)).status_code == 204
    assert client.get("/api/v1/dbc", headers=_auth(tok)).json()["items"] == []
