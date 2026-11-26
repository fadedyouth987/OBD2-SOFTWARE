"""Worker sandbox (A-ENG-8): a memory cap and no network except the task broker.

Schematic PDFs are untrusted input. Each worker process caps its address space
and refuses outbound connections to anything but the Celery broker, so a
malicious file can neither exhaust the host nor reach the internet.
"""

from __future__ import annotations

import os
import resource
import socket
from urllib.parse import urlparse

_real_create_connection = socket.create_connection
_real_connect = socket.socket.connect


def broker_hosts(broker_url: str) -> set[str]:
    host = urlparse(broker_url).hostname or "localhost"
    return {host, "localhost", "127.0.0.1", "::1"}


def apply_memory_cap(megabytes: int) -> None:
    if megabytes <= 0:
        return
    limit = megabytes * 1024 * 1024
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    if hard != resource.RLIM_INFINITY:
        limit = min(limit, hard)
    resource.setrlimit(resource.RLIMIT_AS, (limit, hard))


def block_egress(allowed: set[str]) -> None:
    """Refuse TCP connections to hosts other than ``allowed`` (by name or literal IP)."""

    def _host_of(address) -> str:
        return str(address[0]) if isinstance(address, tuple) and address else str(address)

    def guarded_create_connection(address, *args, **kwargs):
        if _host_of(address) not in allowed:
            raise PermissionError(f"ai-worker has no network access to {_host_of(address)}")
        return _real_create_connection(address, *args, **kwargs)

    def guarded_connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6) and _host_of(address) not in allowed:
            raise PermissionError(f"ai-worker has no network access to {_host_of(address)}")
        return _real_connect(self, address)

    socket.create_connection = guarded_create_connection
    socket.socket.connect = guarded_connect


def restore_network() -> None:
    socket.create_connection = _real_create_connection
    socket.socket.connect = _real_connect


def apply_from_env(broker_url: str) -> None:
    apply_memory_cap(int(os.environ.get("AI_WORKER_MEMORY_MB", "1024")))
    if os.environ.get("AI_WORKER_BLOCK_EGRESS", "true").lower() != "false":
        extra = {h for h in os.environ.get("AI_WORKER_ALLOWED_HOSTS", "").split(",") if h}
        block_egress(broker_hosts(broker_url) | extra)
