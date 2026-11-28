"""Review M5: embedding labels, transport and residency checks, and the fallback."""

from __future__ import annotations

import json

import pytest

from app.services import embeddings as emb


class _Resp:
    def __init__(self, vec):
        self.body = json.dumps({"data": [{"embedding": vec}]}).encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def clean_env(monkeypatch):
    for k in ("EMBEDDING_BACKEND_URL", "EMBEDDING_MODEL", "EMBEDDING_ALLOWED_HOSTS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("DATA_RESIDENCY_ENFORCE", "true")
    return monkeypatch


def test_no_backend_is_labelled_as_the_hash(clean_env):
    vec, model = emb.embed("P0301 misfire")
    assert model == emb.FALLBACK_EMBEDDING_MODEL and len(vec) == emb.EMBEDDING_DIM
    assert emb.embed_canonical_text("P0301 misfire") == vec


def test_backend_vectors_carry_the_backend_model(clean_env):
    clean_env.setenv(
        "EMBEDDING_BACKEND_URL", "https://embed.ap-southeast-2.example.com/v1/embeddings"
    )
    clean_env.setenv("EMBEDDING_MODEL", "bge-small")
    sent = {}

    def fake(req, timeout):
        sent["url"] = req.full_url
        return _Resp([1.0] + [0.0] * (emb.EMBEDDING_DIM - 1))

    clean_env.setattr(emb.urllib.request, "urlopen", fake)
    vec, model = emb.embed("x")
    assert model == "bge-small" and vec[0] == 1.0
    assert "ap-southeast-2" in sent["url"]


@pytest.mark.parametrize(
    "url",
    [
        "http://embed.ap-southeast-2.example.com/v1",  # plain http off-box
        "https://api.openai.com/v1/embeddings",  # outside the region
        "https:///nohost",
    ],
)
def test_refused_backends_fall_back_without_a_request(clean_env, url):
    clean_env.setenv("EMBEDDING_BACKEND_URL", url)
    called = []
    clean_env.setattr(emb.urllib.request, "urlopen", lambda *a, **k: called.append(a))
    vec, model = emb.embed("x")
    assert called == [] and model == emb.FALLBACK_EMBEDDING_MODEL and len(vec) == 384


def test_allow_list_and_local_dev(clean_env):
    clean_env.setenv("EMBEDDING_ALLOWED_HOSTS", "embed.internal.example")
    assert emb.check_backend_url("https://embed.internal.example/v1")
    assert emb.check_backend_url("http://localhost:8080/v1")
    clean_env.setenv("DATA_RESIDENCY_ENFORCE", "false")
    assert emb.check_backend_url("https://api.openai.com/v1")
    with pytest.raises(emb.EmbeddingBackendRefused):
        emb.check_backend_url("http://api.openai.com/v1")


def test_backend_failure_falls_back_and_is_counted(clean_env):
    from app.observability.metrics import render_prometheus

    clean_env.setenv("EMBEDDING_BACKEND_URL", "https://embed.ap-southeast-2.example.com/v1")

    def boom(*a, **k):
        raise OSError("connection refused")

    clean_env.setattr(emb.urllib.request, "urlopen", boom)
    vec, model = emb.embed("x")
    assert model == emb.FALLBACK_EMBEDDING_MODEL and len(vec) == 384
    assert "embedding_fallback_total" in render_prometheus()

    clean_env.setattr(emb.urllib.request, "urlopen", lambda *a, **k: _Resp([0.1] * 10))
    assert emb.embed("x")[1] == emb.FALLBACK_EMBEDDING_MODEL  # wrong dimension
