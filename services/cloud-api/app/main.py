"""FastAPI entry point. Task 0.1 scaffold: health endpoint only."""

from fastapi import FastAPI

from app.config import get_settings

settings = get_settings()  # fails fast on a residency violation

app = FastAPI(title="obd2-diag cloud API", version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "region": settings.aws_region}
