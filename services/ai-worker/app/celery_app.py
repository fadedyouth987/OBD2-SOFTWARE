"""Celery application. Task 0.1 scaffold: one health task.

Schematic ingestion (Task 3.2) and embedding jobs (Task 3.3) register here later.
"""

import os

from celery import Celery

celery_app = Celery(
    "ai_worker",
    broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
)
celery_app.conf.update(task_acks_late=True, worker_prefetch_multiplier=1, timezone="UTC")


@celery_app.task(name="ai_worker.ping")
def ping() -> str:
    return "pong"
