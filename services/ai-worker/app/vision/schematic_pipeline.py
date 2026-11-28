"""Hybrid vector-first schematic-to-graph pipeline (Task 3.2, A-ENG-8)."""

from __future__ import annotations

import json
import multiprocessing
import os
import select
import signal
import time
from typing import Any

from app.vision.raster_extract import extract_raster_fallback
from app.vision.vector_extract import extract_vector_nodes, validate_pdf_limits

# A-ENG-8: one bad page (a parser bug or a pathological drawing) can't stall the
# whole upload. Default one minute per page [estimated], overridable for ops.
PAGE_TIMEOUT_S = float(os.environ.get("AI_WORKER_PAGE_TIMEOUT_S", "60"))
# A page's nodes come back from the child as JSON; cap what the parent will read.
MAX_PAGE_RESULT_BYTES = 16 * 1024 * 1024


class PageTimeout(Exception):
    pass


class PageFailed(Exception):
    """The page's extractor raised; ``reason`` is the exception's class name."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _extract_page(idx: int, text: str) -> list[dict[str, Any]]:
    vec_nodes = extract_vector_nodes(text)
    return vec_nodes if vec_nodes else extract_raster_fallback(idx, ocr_text=text)


def _encode(idx: int, text: str) -> bytes:
    try:
        return json.dumps({"ok": _extract_page(idx, text)}).encode()
    except Exception as exc:  # noqa: BLE001 - reported to the parent as the page's reason
        return json.dumps({"error": type(exc).__name__}).encode()


def _decode(raw: bytes) -> list[dict[str, Any]]:
    try:
        msg = json.loads(raw.decode())
    except ValueError as exc:  # the child died mid-write (memory cap, crash)
        raise PageFailed("WorkerCrashed") from exc
    if "error" in msg:
        raise PageFailed(str(msg["error"]))
    nodes = msg.get("ok")
    if not isinstance(nodes, list):
        raise PageFailed("BadResult")
    return nodes


def _run_forked(idx: int, text: str, seconds: float) -> list[dict[str, Any]]:
    """POSIX: extract the page in a forked child and SIGKILL it at the deadline.

    A runaway parser (pure Python or stuck in C) is really stopped: nothing keeps
    running after the page is marked timed out. The child answers in JSON, never
    pickle, so a page that compromised the parser can't run code in the worker.
    """
    r, w = os.pipe()
    pid = os.fork()
    if pid == 0:  # child
        os.close(r)
        try:
            data = _encode(idx, text)
            view = memoryview(data)
            while view:
                view = view[os.write(w, view) :]
        finally:
            os._exit(0)
    os.close(w)
    deadline = time.monotonic() + seconds
    chunks: list[bytes] = []
    size = 0
    try:
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise PageTimeout
            ready, _, _ = select.select([r], [], [], left)
            if not ready:
                raise PageTimeout
            chunk = os.read(r, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_PAGE_RESULT_BYTES:
                raise PageFailed("ResultTooLarge")
            chunks.append(chunk)
    except BaseException:
        _kill(pid)
        raise
    finally:
        os.close(r)
    os.waitpid(pid, 0)
    return _decode(b"".join(chunks))


def _kill(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)


def _spawned_child(idx: int, text: str, conn) -> None:  # pragma: no cover - Windows only
    conn.send_bytes(_encode(idx, text))
    conn.close()


def _run_spawned(idx: int, text: str, seconds: float) -> list[dict[str, Any]]:
    """Windows (no fork): a spawned process, terminated at the deadline."""
    ctx = multiprocessing.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_spawned_child, args=(idx, text, child), daemon=True)
    proc.start()
    child.close()
    try:
        if not parent.poll(seconds):
            raise PageTimeout
        raw = parent.recv_bytes(MAX_PAGE_RESULT_BYTES)
    except EOFError as exc:
        raise PageFailed("WorkerCrashed") from exc
    except OSError as exc:
        raise PageFailed("ResultTooLarge") from exc
    finally:
        if proc.is_alive():
            proc.terminate()
        proc.join(5)
        parent.close()
    return _decode(raw)


def _run_page(idx: int, text: str, seconds: float) -> list[dict[str, Any]]:
    """Extract one page with a hard wall-clock limit that really stops the work."""
    if seconds <= 0:
        try:
            return _extract_page(idx, text)
        except Exception as exc:  # noqa: BLE001
            raise PageFailed(type(exc).__name__) from exc
    if hasattr(os, "fork"):
        return _run_forked(idx, text, seconds)
    return _run_spawned(idx, text, seconds)


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
            page_nodes = _run_page(idx, text, limit)
        except PageTimeout:
            # Shown to the technician as "couldn't read this page"; the rest still ingests.
            failed_pages.append({"page": idx, "reason": "timed_out"})
            continue
        except PageFailed as exc:  # one unreadable page never fails the upload
            failed_pages.append({"page": idx, "reason": exc.reason})
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
