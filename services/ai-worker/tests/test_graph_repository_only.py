"""A-ENG-6: Neo4j has no row security, so every Cypher query must go through the one
tenant-scoped repository. This test fails if any other module touches the driver."""

import re
from pathlib import Path

SERVICES = Path(__file__).resolve().parents[2]
ALLOWED = {SERVICES / "ai-worker" / "app" / "graph" / "neo4j_client.py"}
FORBIDDEN = re.compile(
    r"^\s*(from\s+neo4j\b|import\s+neo4j\b)|GraphDatabase\s*\.|\.execute_query\(|\bsession\.run\(",
    re.M,
)


def _app_sources():
    for service in ("ai-worker", "cloud-api"):
        yield from (SERVICES / service / "app").rglob("*.py")


def test_only_the_repository_uses_the_neo4j_driver():
    offenders = [
        f"{path.relative_to(SERVICES)}:{text[: m.start()].count(chr(10)) + 1}"
        for path in _app_sources()
        if path not in ALLOWED
        for text in [path.read_text(encoding="utf-8")]
        for m in FORBIDDEN.finditer(text)
    ]
    assert not offenders, "raw Neo4j access outside the repository: " + ", ".join(offenders)


def test_the_check_would_catch_a_violation():
    assert FORBIDDEN.search("from neo4j import GraphDatabase")
    assert FORBIDDEN.search("with driver.session() as session:\n    session.run('MATCH (n)')")
