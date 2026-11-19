from app.celery_app import celery_app, ping


def test_ping_runs_eagerly() -> None:
    celery_app.conf.task_always_eager = True
    assert ping.delay().get(timeout=1) == "pong"
