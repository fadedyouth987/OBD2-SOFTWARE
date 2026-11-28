"""Self-hosted ap-southeast-2 384-dim embedding & numeric feature vector builder (Task 3.3)."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import urllib.request
from collections.abc import Sequence
from urllib.parse import urlparse

from app.observability.metrics import inc

EMBEDDING_DIM = 384
EMBEDDING_MODEL = "bge-small-en-v1.5-ap-se-2"
FALLBACK_EMBEDDING_MODEL = "local-hash-384-v1"


log = logging.getLogger("obd2.embeddings")

REQUIRED_REGION = "ap-southeast-2"
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class EmbeddingBackendRefused(ValueError):
    """EMBEDDING_BACKEND_URL breaks the transport or residency rules (review M5)."""


def _truthy(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


def check_backend_url(url: str) -> str:
    """Only HTTPS (plain HTTP to this machine is allowed for dev), and with
    DATA_RESIDENCY_ENFORCE on, only hosts named for ap-southeast-2 or listed in
    EMBEDDING_ALLOWED_HOSTS. Case text never leaves the region by accident."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if not host:
        raise EmbeddingBackendRefused("EMBEDDING_BACKEND_URL has no host")
    local = host in _LOCAL_HOSTS
    if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
        raise EmbeddingBackendRefused("EMBEDDING_BACKEND_URL must use https")
    if _truthy("DATA_RESIDENCY_ENFORCE", "true") and not local:
        allowed = {
            h.strip().lower()
            for h in os.environ.get("EMBEDDING_ALLOWED_HOSTS", "").split(",")
            if h.strip()
        }
        if REQUIRED_REGION not in host and host not in allowed:
            raise EmbeddingBackendRefused(
                f"EMBEDDING_BACKEND_URL host {host!r} isn't in {REQUIRED_REGION}; "
                "add it to EMBEDDING_ALLOWED_HOSTS if it is"
            )
    return url


def active_embedding_model() -> str:
    """The model ID the backend is configured for (the hash fallback when unset).

    A vector's label comes from :func:`embed`, which says what actually produced it.
    """
    if os.environ.get("EMBEDDING_BACKEND_URL", "").strip():
        return os.environ.get("EMBEDDING_MODEL", EMBEDDING_MODEL).strip() or EMBEDDING_MODEL
    return FALLBACK_EMBEDDING_MODEL


def _hash_embedding(text: str) -> list[float]:
    vec: list[float] = []
    seed = text.encode("utf-8")
    counter = 0
    while len(vec) < EMBEDDING_DIM:
        digest = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for i in range(0, len(digest), 2):
            if len(vec) >= EMBEDDING_DIM:
                break
            val = int.from_bytes(digest[i : i + 2], "big") / 32767.5 - 1.0
            vec.append(val)
        counter += 1
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [round(v / norm, 6) for v in vec]


def _backend_embedding(url: str, model: str, text: str) -> list[float]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    api_key = os.environ.get("EMBEDDING_API_KEY", "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        url,
        data=json.dumps({"model": model, "input": text}).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10.0) as resp:  # noqa: S310 - checked above
        payload = json.loads(resp.read().decode("utf-8"))
    raw_vec = payload["data"][0]["embedding"]
    if len(raw_vec) != EMBEDDING_DIM:
        raise ValueError(f"expected {EMBEDDING_DIM}-dim embedding, got {len(raw_vec)}")
    vec = [float(x) for x in raw_vec]
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [round(v / norm, 6) for v in vec]


def embed(text: str) -> tuple[list[float], str]:
    """A unit-norm 384-dim vector and the ID of the model that really made it.

    With ``EMBEDDING_BACKEND_URL`` set (OpenAI-compatible ``/v1/embeddings``) the
    backend is used. If it is refused by :func:`check_backend_url`, or fails, the
    deterministic hash projection is used instead, labelled as such, logged and
    counted (``embedding_fallback_total``), so publishing a case never fails on it
    and hash vectors are never stored as BGE ones.
    """
    url = os.environ.get("EMBEDDING_BACKEND_URL", "").strip()
    if url:
        model = active_embedding_model()
        try:
            return _backend_embedding(check_backend_url(url), model, text), model
        except Exception as exc:  # noqa: BLE001 - any backend failure falls back
            log.warning("embedding backend unavailable, using the hash fallback: %s", exc)
            inc("embedding_fallback_total")
    return _hash_embedding(text), FALLBACK_EMBEDDING_MODEL


def embed_canonical_text(text: str) -> list[float]:
    """The vector alone; prefer :func:`embed`, which also says which model made it."""
    return embed(text)[0]


def build_feature_vector(
    rpm: float = 0.0,
    coolant_c: float = 85.0,
    battery_v: float = 13.8,
    stft_pct: float = 0.0,
    ltft_pct: float = 0.0,
) -> list[float]:
    return [
        round(rpm / 6000.0, 4),
        round(coolant_c / 120.0, 4),
        round(battery_v / 16.0, 4),
        round(stft_pct / 25.0, 4),
        round(ltft_pct / 25.0, 4),
    ]


def cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        raise ValueError("cosine_similarity requires equal-length vectors")
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)
