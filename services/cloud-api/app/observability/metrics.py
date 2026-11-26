"""Cloud API Prometheus metrics (Task 5.2, A-CEO-5).

Process-local and dependency-free. Prometheus sums across replicas, so every
metric here is a counter, a running sum/count pair, or a gauge that is
meaningful per replica (``obd2_daemons_seen`` is the daemons this replica saw).

- ``inc(name)``: an operational event, ``obd2_cloud_events_total{name=...}``.
- ``count(metric, **labels)``: a labelled counter.
- ``observe(metric, seconds, **labels)``: ``_sum`` and ``_count`` (a summary
  without quantiles), so dashboards can graph rates and averages.
- ``daemon_seen(key, version)``: active daemons by version over 24 hours.
"""

from __future__ import annotations

import threading
import time
from collections import Counter

_lock = threading.Lock()
_EVENTS: Counter[str] = Counter()
_COUNTERS: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
_SUMMARIES: dict[tuple[str, tuple[tuple[str, str], ...]], list[float]] = {}
_DAEMONS: dict[str, tuple[str, float]] = {}
DAEMON_WINDOW_S = 24 * 3600

_HELP = {
    "obd2_http_requests_total": "API responses by route class and status class.",
    "obd2_http_request_duration_seconds": "API response time.",
    "obd2_sync_lag_seconds": "Delay between an edge batch's watermark and its arrival.",
    "obd2_sync_batches_total": "Edge sync batches by outcome.",
    "obd2_diagnose_duration_seconds": "Time to answer a diagnosis or follow-up.",
    "obd2_diagnose_total": "Diagnoses by engine and fallback reason.",
    "obd2_stripe_webhook_failures_total": "Stripe webhooks rejected or not applied.",
    "obd2_schematic_ingest_failures_total": "Schematic uploads that could not be ingested.",
    "obd2_schematic_uploads_total": "Schematic uploads stored and charged.",
}


def _key(metric: str, labels: dict[str, object]) -> tuple[str, tuple[tuple[str, str], ...]]:
    return metric, tuple(sorted((k, str(v)) for k, v in labels.items()))


def inc(metric: str, amount: int = 1) -> None:
    with _lock:
        _EVENTS[metric] += amount


def count(metric: str, amount: float = 1, **labels: object) -> None:
    k = _key(metric, labels)
    with _lock:
        _COUNTERS[k] = _COUNTERS.get(k, 0) + amount


def observe(metric: str, value: float, **labels: object) -> None:
    k = _key(metric, labels)
    with _lock:
        s = _SUMMARIES.setdefault(k, [0.0, 0.0])
        s[0] += value
        s[1] += 1


def daemon_seen(key: str, version: str | None, now: float | None = None) -> None:
    if not key:
        return
    with _lock:
        _DAEMONS[key] = (version or "unknown", now if now is not None else time.time())


def daemons_by_version(now: float | None = None) -> dict[str, int]:
    cutoff = (now if now is not None else time.time()) - DAEMON_WINDOW_S
    out: Counter[str] = Counter()
    with _lock:
        for key, (version, at) in list(_DAEMONS.items()):
            if at < cutoff:
                del _DAEMONS[key]
            else:
                out[version] += 1
    return dict(out)


def _labels(pairs: tuple[tuple[str, str], ...]) -> str:
    if not pairs:
        return ""
    body = ",".join(f'{k}="{v.replace(chr(92), "").replace(chr(34), "")}"' for k, v in pairs)
    return "{" + body + "}"


def render_prometheus() -> str:
    lines: list[str] = []
    with _lock:
        lines.append("# TYPE obd2_cloud_events_total counter")
        for name, val in sorted(_EVENTS.items()):
            lines.append(f'obd2_cloud_events_total{{name="{name}"}} {val}')
        typed: set[str] = set()
        for (metric, pairs), val in sorted(_COUNTERS.items()):
            if metric not in typed:
                typed.add(metric)
                if metric in _HELP:
                    lines.append(f"# HELP {metric} {_HELP[metric]}")
                lines.append(f"# TYPE {metric} counter")
            lines.append(f"{metric}{_labels(pairs)} {val:g}")
        for (metric, pairs), (total, n) in sorted(_SUMMARIES.items()):
            if metric not in typed:
                typed.add(metric)
                if metric in _HELP:
                    lines.append(f"# HELP {metric} {_HELP[metric]}")
                lines.append(f"# TYPE {metric} summary")
            lines.append(f"{metric}_sum{_labels(pairs)} {total:.6f}")
            lines.append(f"{metric}_count{_labels(pairs)} {n:g}")
    lines.append("# HELP obd2_daemons_seen Edge daemons seen in the last 24 hours, by version.")
    lines.append("# TYPE obd2_daemons_seen gauge")
    for version, n in sorted(daemons_by_version().items()):
        lines.append(f'obd2_daemons_seen{{version="{version}"}} {n}')
    return "\n".join(lines) + "\n"


def reset_for_tests() -> None:
    with _lock:
        _EVENTS.clear()
        _COUNTERS.clear()
        _SUMMARIES.clear()
        _DAEMONS.clear()
