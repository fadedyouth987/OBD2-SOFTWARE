"""FastAPI entry point wiring Tasks 2.1, 2.2, 2.3, 3.3, and 5.2."""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

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
from app.observability.metrics import render_prometheus

settings = get_settings()  # fails fast on ap-southeast-2 residency violation

app = FastAPI(title="obd2-diag cloud API", version="0.2.0")

allowed_origins = [
    o.strip()
    for o in os.environ.get(
        "EDGE_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "region": settings.aws_region}


@app.get("/metrics", response_class=PlainTextResponse)
def metrics() -> str:
    return render_prometheus()
