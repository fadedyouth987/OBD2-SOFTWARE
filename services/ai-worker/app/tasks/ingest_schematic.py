"""Celery task for PDF schematic ingestion (Task 3.2)."""
from __future__ import annotations

from app.celery_app import celery_app
from app.vision.schematic_pipeline import run_schematic_pipeline


@celery_app.task(name="ai_worker.ingest_schematic", time_limit=120)
def ingest_schematic_task(tenant_id: str, size_bytes: int, pages: list[str]) -> dict:
    result = run_schematic_pipeline(size_bytes=size_bytes, pages=pages)
    return {"tenant_id": tenant_id, **result}
