"""Celery application with schematic ingestion task registered (Tasks 0.1 & 3.2)."""

import os

from celery import Celery

celery_app = Celery(
    "ai_worker",
    broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    include=["app.tasks.ingest_schematic"],
)
celery_app.conf.update(task_acks_late=True, worker_prefetch_multiplier=1, timezone="UTC")


@celery_app.task(name="ai_worker.ping")
def ping() -> str:
    return "pong"
