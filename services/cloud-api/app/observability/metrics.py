"""Cloud API Prometheus metrics & operational counters (Task 5.2, A-CEO-5)."""

from __future__ import annotations

from collections import Counter

_COUNTERS: Counter[str] = Counter()


def inc(metric: str, amount: int = 1) -> None:
    _COUNTERS[metric] += amount


def render_prometheus() -> str:
    lines = ["# TYPE obd2_cloud_requests_total counter"]
    for key, val in sorted(_COUNTERS.items()):
        lines.append(f'obd2_cloud_metric{{name="{key}"}} {val}')
    return "\n".join(lines) + "\n"
