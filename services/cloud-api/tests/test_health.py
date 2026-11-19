from fastapi.testclient import TestClient

from app.main import app


def test_healthz_reports_ok_and_region() -> None:
    response = TestClient(app).get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "region": "ap-southeast-2"}
