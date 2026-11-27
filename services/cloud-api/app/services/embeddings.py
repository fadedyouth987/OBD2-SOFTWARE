"""Self-hosted ap-southeast-2 384-dim embedding & numeric feature vector builder (Task 3.3)."""

from __future__ import annotations

import hashlib
import json
import math
import os
import urllib.request
from collections.abc import Sequence

EMBEDDING_DIM = 384
EMBEDDING_MODEL = "bge-small-en-v1.5-ap-se-2"
FALLBACK_EMBEDDING_MODEL = "local-hash-384-v1"


def active_embedding_model() -> str:
    """Returns the model ID matching the vector space actually generated.

    Prevents hash-fallback vectors from being mislabeled as BGE embeddings when
    ``EMBEDDING_BACKEND_URL`` is unset.
    """
    if os.environ.get("EMBEDDING_BACKEND_URL", "").strip():
        return os.environ.get("EMBEDDING_MODEL", EMBEDDING_MODEL).strip() or EMBEDDING_MODEL
    return FALLBACK_EMBEDDING_MODEL


def embed_canonical_text(text: str) -> list[float]:
    """Computes a unit-norm 384-dim embedding in ap-southeast-2.

    Uses the configured regional ``EMBEDDING_BACKEND_URL`` (OpenAI-compatible
    ``/v1/embeddings``) when set; otherwise falls back to a deterministic
    unit-norm hash projection (never making outbound calls outside ap-southeast-2).
    """
    backend_url = os.environ.get("EMBEDDING_BACKEND_URL", "").strip()
    if backend_url:
        model = active_embedding_model()
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        api_key = os.environ.get("EMBEDDING_API_KEY", "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(
            backend_url,
            data=json.dumps({"model": model, "input": text}).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        raw_vec = payload["data"][0]["embedding"]
        if len(raw_vec) != EMBEDDING_DIM:
            raise ValueError(f"expected {EMBEDDING_DIM}-dim embedding, got {len(raw_vec)}")
        vec = [float(x) for x in raw_vec]
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        return [round(v / norm, 6) for v in vec]

    vec = []
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
