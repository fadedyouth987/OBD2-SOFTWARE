"""Structured JSON logs with a request ID carried web → API → worker (Task 5.2).

The web app sends ``X-Request-ID`` on every call; the API accepts it when it is
a safe token (or makes one), returns it on the response, puts it on every log
line written while handling the request, and passes it on to worker tasks.
"""

from __future__ import annotations

import contextvars
import json
import logging
import re
import time
import uuid
from datetime import UTC, datetime

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

from app.observability.metrics import count, observe

REQUEST_ID_HEADER = "X-Request-ID"
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "request_id", default=None
)


def current_request_id() -> str | None:
    return request_id_var.get()


def accept_request_id(raw: str | None) -> str:
    return raw if raw and _SAFE_ID.match(raw) else uuid.uuid4().hex


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": getattr(record, "request_id", None) or current_request_id(),
        }
        for extra in ("method", "route", "status", "duration_ms"):
            if hasattr(record, extra):
                entry[extra] = getattr(record, extra)
        if record.exc_info:
            entry["exc_type"] = record.exc_info[0].__name__ if record.exc_info[0] else None
        return json.dumps(entry, ensure_ascii=False)


def configure_json_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if any(isinstance(h.formatter, JsonFormatter) for h in root.handlers):
        return
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    root.setLevel(level)


access_log = logging.getLogger("obd2.access")


def _route_class(request: Request) -> str:
    """The route template (``/api/v1/jobs/{job_id}``), never raw IDs, for metric labels."""
    route = request.scope.get("route")
    return getattr(route, "path", None) or "unmatched"


class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        rid = accept_request_id(request.headers.get(REQUEST_ID_HEADER))
        token = request_id_var.set(rid)
        start = time.perf_counter()
        status = 500
        try:
            response = await call_next(request)
            status = response.status_code
            response.headers[REQUEST_ID_HEADER] = rid
            return response
        finally:
            elapsed = time.perf_counter() - start
            route = _route_class(request)
            count("obd2_http_requests_total", route=route, status=f"{status // 100}xx")
            observe("obd2_http_request_duration_seconds", elapsed, route=route)
            access_log.info(
                "request",
                extra={
                    "request_id": rid,
                    "method": request.method,
                    "route": route,
                    "status": status,
                    "duration_ms": round(elapsed * 1000, 1),
                },
            )
            request_id_var.reset(token)
