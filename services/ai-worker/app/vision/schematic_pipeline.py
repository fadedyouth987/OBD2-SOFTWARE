"""Hybrid vector-first schematic-to-graph pipeline (Task 3.2, A-ENG-8)."""

from __future__ import annotations

import os
import signal
import threading
from collections.abc import Callable
from typing import Any

from app.vision.raster_extract import extract_raster_fallback
from app.vision.vector_extract import extract_vector_nodes, validate_pdf_limits

# A-ENG-8: one bad page (a parser bug or a pathological drawing) can't stall the
# whole upload. Default one minute per page [estimated], overridable for ops.
PAGE_TIMEOUT_S = float(os.environ.get("AI_WORKER_PAGE_TIMEOUT_S", "60"))


class PageTimeout(Exception):
    pass


def _with_timeout[T](fn: Callable[[], T], seconds: float) -> T:
    """Run ``fn`` with a wall-clock limit (SIGALRM; worker tasks run on the main thread)."""
    if seconds <= 0 or threading.current_thread() is not threading.main_thread():
        return fn()

    def _raise(signum, frame):  # noqa: ARG001
        raise PageTimeout

    previous = signal.signal(signal.SIGALRM, _raise)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        return fn()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _extract_page(idx: int, text: str) -> list[dict[str, Any]]:
    vec_nodes = extract_vector_nodes(text)
    return vec_nodes if vec_nodes else extract_raster_fallback(idx, ocr_text=text)


def run_schematic_pipeline(
    size_bytes: int, pages: list[str], page_timeout_s: float | None = None
) -> dict[str, Any]:
    validate_pdf_limits(size_bytes=size_bytes, page_count=len(pages))
    limit = PAGE_TIMEOUT_S if page_timeout_s is None else page_timeout_s
    extracted: list[dict[str, Any]] = []
    failed_pages: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, text in enumerate(pages, start=1):
        try:
            page_nodes = _with_timeout(lambda i=idx, t=text: _extract_page(i, t), limit)
        except PageTimeout:
            # Shown to the technician as "couldn't read this page"; the rest still ingests.
            failed_pages.append({"page": idx, "reason": "timed_out"})
            continue
        except Exception as exc:  # noqa: BLE001 - one unreadable page never fails the upload
            failed_pages.append({"page": idx, "reason": type(exc).__name__})
            continue
        for node in page_nodes:
            nid = node["node_id"]
            if nid not in seen_ids:
                seen_ids.add(nid)
                extracted.append(node)
    return {
        "page_count": len(pages),
        "node_count": len(extracted),
        "nodes": extracted,
        "failed_pages": failed_pages,
    }
