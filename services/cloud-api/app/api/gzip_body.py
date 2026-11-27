"""Gzip request bodies for session sync (Task 2.2: "compressed telemetry batches").

A pure ASGI middleware: for the listed paths, a body sent with
``Content-Encoding: gzip`` is inflated before FastAPI parses it. Plain JSON
passes through untouched, so existing callers are unaffected.

A small gzip body can expand a thousandfold, so inflating is only done for a
caller whose session token verifies (a cheap signature check, before a single
body byte is read); the route still runs its full authorization. Inflating runs
in a worker thread, never on the event loop. Limits: at most ``MAX_COMPRESSED``
bytes read and ``MAX_INFLATED`` produced (413 past either); corrupt, truncated
or trailing data is a 400 (one gzip member only); any other encoding a 415.
Register it inside CORS so browsers can read these refusals.
"""

from __future__ import annotations

import zlib
from collections.abc import Iterable

from anyio import to_thread
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.services.signing import SigningKeyError, verify_session_jwt

MAX_COMPRESSED = 8 * 1024 * 1024
MAX_INFLATED = 32 * 1024 * 1024


class _BadBody(Exception):
    def __init__(self, status: int, detail: str) -> None:
        self.status, self.detail = status, detail


def _inflate(raw: bytes) -> bytes:
    inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
    try:
        body = inflater.decompress(raw, MAX_INFLATED + 1)
    except zlib.error as exc:
        raise _BadBody(400, "body is not valid gzip") from exc
    if len(body) > MAX_INFLATED or inflater.unconsumed_tail:
        raise _BadBody(413, f"body over {MAX_INFLATED // 2**20} MiB once inflated")
    if not inflater.eof:
        raise _BadBody(400, "gzip body is truncated")
    if inflater.unused_data:
        raise _BadBody(400, "data after the gzip stream (send one gzip member)")
    return body


def _session_ok(headers: dict[bytes, bytes]) -> bool:
    scheme, _, token = headers.get(b"authorization", b"").decode("latin-1").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return False
    try:
        verify_session_jwt(token.strip())
    except (SigningKeyError, ValueError, KeyError):
        return False
    return True


class GzipRequestMiddleware:
    def __init__(self, app: ASGIApp, paths: Iterable[str]) -> None:
        self.app = app
        self.paths = frozenset(paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] not in self.paths:
            await self.app(scope, receive, send)
            return
        headers = dict(scope["headers"])
        encoding = headers.get(b"content-encoding", b"identity").decode("latin-1").strip().lower()
        if encoding == "identity":
            await self.app(scope, receive, send)
            return

        async def refuse(status: int, detail: str) -> None:
            await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)

        if encoding != "gzip":
            await refuse(415, "Content-Encoding must be gzip or identity")
            return
        if not _session_ok(headers):
            await refuse(401, "Not authenticated")
            return

        raw = bytearray()
        more = True
        while more:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            raw += message.get("body", b"")
            more = message.get("more_body", False)
            if len(raw) > MAX_COMPRESSED:
                await refuse(413, f"compressed body over {MAX_COMPRESSED // 2**20} MiB")
                return
        try:
            body = await to_thread.run_sync(_inflate, bytes(raw))
        except _BadBody as exc:
            await refuse(exc.status, exc.detail)
            return
        del raw

        rewritten = [
            (k, v) for k, v in scope["headers"] if k not in (b"content-encoding", b"content-length")
        ] + [(b"content-length", str(len(body)).encode())]
        sent = False

        async def inflated_receive() -> Message:
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        await self.app({**scope, "headers": rewritten}, inflated_receive, send)
