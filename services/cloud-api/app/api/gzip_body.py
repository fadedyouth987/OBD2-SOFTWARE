"""Gzip request bodies for session sync (Task 2.2: "compressed telemetry batches").

A pure ASGI middleware: for the listed paths, a body sent with
``Content-Encoding: gzip`` is inflated before FastAPI parses it. Plain JSON
passes through untouched, so existing callers are unaffected. Limits stop a
gzip bomb: at most ``MAX_COMPRESSED`` bytes are read and at most ``MAX_INFLATED``
produced (413 past either); corrupt or truncated gzip is a 400, any other
encoding a 415.
"""

from __future__ import annotations

import json
import zlib
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

MAX_COMPRESSED = 8 * 1024 * 1024
MAX_INFLATED = 32 * 1024 * 1024

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
App = Callable[[Scope, Receive, Send], Awaitable[None]]


class GzipRequestMiddleware:
    def __init__(self, app: App, paths: Iterable[str]) -> None:
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
        if encoding != "gzip":
            await _error(send, 415, "Content-Encoding must be gzip or identity")
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
                await _error(send, 413, f"compressed body over {MAX_COMPRESSED // 2**20} MiB")
                return
        inflater = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            body = inflater.decompress(bytes(raw), MAX_INFLATED + 1)
        except zlib.error:
            await _error(send, 400, "body is not valid gzip")
            return
        if len(body) > MAX_INFLATED or inflater.unconsumed_tail:
            await _error(send, 413, f"body over {MAX_INFLATED // 2**20} MiB once inflated")
            return
        if not inflater.eof:
            await _error(send, 400, "gzip body is truncated")
            return

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


async def _error(send: Send, status: int, detail: str) -> None:
    payload = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(payload)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": payload})
