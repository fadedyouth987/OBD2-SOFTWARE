"""Celery task for PDF schematic ingestion (Task 3.2)."""

from __future__ import annotations

import logging

from app.celery_app import celery_app
from app.vision.schematic_pipeline import run_schematic_pipeline

log = logging.getLogger(__name__)


@celery_app.task(name="ai_worker.ingest_schematic", time_limit=60 * 60, soft_time_limit=55 * 60)
def ingest_schematic_task(
    tenant_id: str, size_bytes: int, pages: list[str], request_id: str | None = None
) -> dict:
    """``request_id`` is the API request that queued this, so logs join up (Task 5.2)."""
    result = run_schematic_pipeline(size_bytes=size_bytes, pages=pages)
    if result["failed_pages"]:
        log.warning(
            "schematic ingest: %d page(s) failed",
            len(result["failed_pages"]),
            extra={"request_id": request_id, "tenant_id": tenant_id},
        )
    return {"tenant_id": tenant_id, "request_id": request_id, **result}
