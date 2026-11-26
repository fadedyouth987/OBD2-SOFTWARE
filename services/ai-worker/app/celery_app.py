"""Celery application with schematic ingestion task registered (Tasks 0.1 & 3.2)."""

import os

from celery import Celery
from celery.signals import worker_process_init

from app.sandbox import apply_from_env

BROKER_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "ai_worker",
    broker=BROKER_URL,
    backend=BROKER_URL,
    include=["app.tasks.ingest_schematic"],
)
celery_app.conf.update(
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    timezone="UTC",
    # A-ENG-8: recycle a worker child that grows past ~768 MB resident.
    worker_max_memory_per_child=768_000,
)


@worker_process_init.connect
def _sandbox_worker_process(**_kwargs) -> None:
    """Each pool process gets a memory cap and no network but the broker (A-ENG-8)."""
    apply_from_env(BROKER_URL)


@celery_app.task(name="ai_worker.ping")
def ping() -> str:
    return "pong"
