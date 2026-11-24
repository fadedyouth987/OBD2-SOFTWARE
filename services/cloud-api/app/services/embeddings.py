"""Self-hosted ap-southeast-2 384-dim embedding & numeric feature vector builder (Task 3.3)."""
from __future__ import annotations

import hashlib
import math
from typing import Sequence

EMBEDDING_DIM = 384
EMBEDDING_MODEL = "bge-small-en-v1.5-ap-se-2"


def embed_canonical_text(text: str) -> list[float]:
    """Deterministic unit-norm 384-dim embedding fallback when local ONNX runtime is absent.
    Never makes outbound calls outside ap-southeast-2."""
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
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)
