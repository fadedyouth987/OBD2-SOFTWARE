"""Task 5.2 (A-CEO-5): request IDs, JSON logs and the metrics alerts rely on."""

from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.observability import metrics
from app.observability.logging import JsonFormatter, accept_request_id, request_id_var


@pytest.fixture(autouse=True)
def _fresh_metrics():
    metrics.reset_for_tests()
    yield
    metrics.reset_for_tests()


def test_request_id_is_echoed_or_generated():
    client = TestClient(app)
    sent = client.get("/healthz", headers={"X-Request-ID": "web-abc12345"})
    assert sent.headers["X-Request-ID"] == "web-abc12345"
    made = client.get("/healthz")
    assert len(made.headers["X-Request-ID"]) == 32


def test_unsafe_request_ids_are_replaced():
    assert accept_request_id("x" * 200) != "x" * 200
    assert accept_request_id("bad id\nwith newline") != "bad id\nwith newline"
    assert accept_request_id("ok-id-1234") == "ok-id-1234"


def test_json_log_lines_carry_the_request_id():
    token = request_id_var.set("req-12345678")
    try:
        record = logging.LogRecord("obd2", logging.WARNING, __file__, 1, "sync %s", ("late",), None)
        line = json.loads(JsonFormatter().format(record))
    finally:
        request_id_var.reset(token)
    assert line["request_id"] == "req-12345678"
    assert line["msg"] == "sync late" and line["level"] == "warning"


def test_http_metrics_use_route_templates_not_raw_ids():
    client = TestClient(app)
    client.get("/healthz")
    client.get("/api/v1/jobs/3f2b9a8e-0000-0000-0000-000000000000")  # 401 without a token
    text = client.get("/metrics").text
    assert 'obd2_http_requests_total{route="/healthz",status="2xx"}' in text
    assert "3f2b9a8e" not in text
    assert "obd2_http_request_duration_seconds_count" in text


def test_forged_webhook_counts_a_signature_failure(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "stripe_webhook_secret", "whsec_test")
    client = TestClient(app)
    res = client.post(
        "/api/v1/billing/webhook",
        content=b'{"id": "evt_1"}',
        headers={"stripe-signature": "t=1,v1=forged"},
    )
    assert res.status_code == 400
    text = client.get("/metrics").text
    assert 'obd2_stripe_webhook_failures_total{reason="bad_signature"} 1' in text


def test_daemons_by_version_counts_the_last_24_hours():
    now = 1_000_000.0
    metrics.daemon_seen("t1:a", "0.2.0", now=now)
    metrics.daemon_seen("t2:a", "0.2.0", now=now - 3600)
    metrics.daemon_seen("t3:a", "0.1.0", now=now - 2 * 24 * 3600)
    assert metrics.daemons_by_version(now=now) == {"0.2.0": 2}


def test_summary_and_labels_render_in_prometheus_format():
    metrics.observe("obd2_sync_lag_seconds", 2.5)
    metrics.observe("obd2_sync_lag_seconds", 0.5)
    metrics.count("obd2_diagnose_total", engine="rules", fallback_reason="llm_error")
    text = metrics.render_prometheus()
    assert "obd2_sync_lag_seconds_sum 3.000000" in text
    assert "obd2_sync_lag_seconds_count 2" in text
    assert 'obd2_diagnose_total{engine="rules",fallback_reason="llm_error"} 1' in text
