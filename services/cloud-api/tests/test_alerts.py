"""Task 5.2: every alert is well formed, links to a runbook that exists, and only
uses metrics the API actually exports. (A staging drill still has to fire each one.)"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from app.observability import metrics

ROOT = Path(__file__).resolve().parents[3]
ALERTS = ROOT / "infra" / "monitoring" / "alerts.yml"
EXPECTED = {
    "StripeWebhookSignatureFailures",
    "StripeWebhookNotApplied",
    "SyncBacklog",
    "DiagnoseFallbackRate",
    "SchematicIngestFailureRate",
    "ApiErrorBudgetFastBurn",
    "ApiErrorBudgetSlowBurn",
}


def _rules() -> list[dict]:
    doc = yaml.safe_load(ALERTS.read_text(encoding="utf-8"))
    return [r for g in doc["groups"] for r in g["rules"]]


def test_every_contract_alert_exists():
    assert {r["alert"] for r in _rules()} == EXPECTED


def test_each_alert_links_to_an_existing_runbook():
    for rule in _rules():
        url = rule["annotations"]["runbook_url"]
        assert (ROOT / url).is_file(), f"{rule['alert']}: missing runbook {url}"
        assert rule["labels"]["severity"] in {"page", "ticket"}


def test_alerts_only_use_exported_metrics():
    exported = set(metrics._HELP) | {"obd2_daemons_seen"}
    for rule in _rules():
        for name in re.findall(r"\b(obd2_[a-z_]+?)(?:_sum|_count)?\b(?=[\[{(\s])", rule["expr"]):
            base = re.sub(r"_(sum|count)$", "", name)
            assert base in exported, f"{rule['alert']}: unknown metric {name}"


def test_prometheus_loads_the_rules():
    prom = yaml.safe_load((ALERTS.parent / "prometheus.yml").read_text(encoding="utf-8"))
    assert "alerts.yml" in prom["rule_files"]
