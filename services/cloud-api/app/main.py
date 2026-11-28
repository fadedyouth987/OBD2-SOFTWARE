"""FastAPI entry point wiring Tasks 2.1, 2.2, 2.3, 3.3, and 5.2."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy.exc import OperationalError

from app.api.gzip_body import GzipRequestMiddleware
from app.api.v1 import (
    accreditation,
    admin,
    auth,
    billing,
    dbc,
    diagnose,
    gateways,
    immo,
    jobs,
    schematics,
    sessions,
    team,
)
from app.config import get_settings
from app.observability.logging import (
    REQUEST_ID_HEADER,
    RequestIdMiddleware,
    configure_json_logging,
    current_request_id,
)
from app.observability.metrics import inc, render_prometheus

settings = get_settings()  # fails fast on ap-southeast-2 residency violation
if os.environ.get("LOG_FORMAT", "json").lower() == "json":
    configure_json_logging()

app = FastAPI(title="obd2-diag cloud API", version="0.2.0")

allowed_origins = [
    o.strip()
    for o in os.environ.get(
        "EDGE_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    ).split(",")
    if o.strip()
]
# Edge sync batches may arrive gzip-compressed (Task 2.2). Added before CORS so
# it runs inside it: browsers can read its refusals.
app.add_middleware(GzipRequestMiddleware, paths={"/api/v1/sessions/sync"})
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[REQUEST_ID_HEADER],
)
# Outermost, so the request ID covers CORS responses and errors too.
app.add_middleware(RequestIdMiddleware)

app.include_router(auth.router)
app.include_router(sessions.router)
app.include_router(jobs.router)
app.include_router(dbc.router)
app.include_router(billing.router)
app.include_router(gateways.router)
app.include_router(diagnose.router)
app.include_router(immo.router)
app.include_router(team.router)
app.include_router(schematics.router)
app.include_router(accreditation.router)
app.include_router(admin.router)


_db_log = logging.getLogger("obd2.db")


@app.exception_handler(OperationalError)
def db_unavailable_handler(request: Request, exc: OperationalError) -> JSONResponse:
    """Review M7: the cause is logged (with the request ID) instead of swallowed, and
    callers get a neutral message. The local-setup hint shows only with dev login on."""
    rid = current_request_id()
    _db_log.error(
        "database unavailable on %s %s: %s",
        request.method,
        request.url.path,
        exc.orig if getattr(exc, "orig", None) is not None else exc,
        extra={"request_id": rid},
    )
    inc("db_unavailable_total")
    message = "The service is briefly unavailable. Try again in a moment."
    if get_settings().auth_allow_dev_login:
        message += " (Local dev: start PostgreSQL and run the Alembic migrations.)"
    return JSONResponse(status_code=503, content={"detail": message, "request_id": rid})


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "region": settings.aws_region}


@app.get("/metrics", response_class=PlainTextResponse)
def metrics() -> str:
    return render_prometheus()
