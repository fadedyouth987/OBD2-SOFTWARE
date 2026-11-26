"""A-ENG-8: per-page timeout, memory cap and no network for the ingest worker."""

import resource
import socket
import time

import pytest

from app import sandbox
from app.vision import schematic_pipeline
from app.vision.schematic_pipeline import run_schematic_pipeline


def test_slow_page_times_out_and_the_rest_ingests(monkeypatch):
    real = schematic_pipeline._extract_page

    def slow_on_page_two(idx, text):
        if idx == 2:
            time.sleep(2)
        return real(idx, text)

    monkeypatch.setattr(schematic_pipeline, "_extract_page", slow_on_page_two)
    out = run_schematic_pipeline(1024, ["F104", "G101", "X200"], page_timeout_s=0.2)
    assert out["failed_pages"] == [{"page": 2, "reason": "timed_out"}]
    ids = {n["node_id"] for n in out["nodes"]}
    assert {"NODE:F104", "NODE:X200"} <= ids and "NODE:G101" not in ids


def test_a_crashing_page_is_marked_not_fatal(monkeypatch):
    real = schematic_pipeline._extract_page

    def boom(idx, text):
        if idx == 1:
            raise ValueError("bad drawing")
        return real(idx, text)

    monkeypatch.setattr(schematic_pipeline, "_extract_page", boom)
    out = run_schematic_pipeline(1024, ["F104", "G101"], page_timeout_s=5)
    assert out["failed_pages"] == [{"page": 1, "reason": "ValueError"}]
    assert out["node_count"] >= 1


def test_egress_blocked_except_broker():
    allowed = sandbox.broker_hosts("redis://redis.internal:6379/0")
    assert "redis.internal" in allowed
    sandbox.block_egress(allowed)
    try:
        with pytest.raises(PermissionError):
            socket.create_connection(("example.com", 443), timeout=1)
        with pytest.raises(PermissionError):
            socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect(("93.184.216.34", 80))
    finally:
        sandbox.restore_network()


def test_memory_cap_is_applied():
    before = resource.getrlimit(resource.RLIMIT_AS)
    try:
        sandbox.apply_memory_cap(4096)
        soft, _ = resource.getrlimit(resource.RLIMIT_AS)
        assert soft == 4096 * 1024 * 1024
    finally:
        resource.setrlimit(resource.RLIMIT_AS, before)
