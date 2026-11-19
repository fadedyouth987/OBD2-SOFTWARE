#!/usr/bin/env bash
# Task 0.1 Verification Gate: bring up local infrastructure and prove each service is usable.
#   - postgres healthy, with the timescaledb and vector extensions installed
#   - pgvector >= 0.8.0 (eng review contract assumption for iterative index scans, A-ENG-7)
#   - neo4j healthy, with APOC loaded
#   - redis answers PING
#   - the S3 trace bucket exists
# Usage: scripts/infra-gate.sh [--down]   (--down tears everything down afterwards)
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f infra/docker-compose.yml)
[ -f .env ] && COMPOSE+=(--env-file .env) || COMPOSE+=(--env-file .env.example)
BUCKET="${S3_BUCKET:-automotive-traces-au}"
NEO4J_PW="${NEO4J_PASSWORD:-diag-dev-password}"
fail() { echo "GATE FAIL: $*" >&2; exit 1; }

if ! docker info >/dev/null 2>&1; then
  fail "Docker daemon is not reachable. See docs/dev/no-docker.md for the no-Docker path."
fi

echo "== Starting infrastructure (waits for health checks)"
"${COMPOSE[@]}" up -d --wait --wait-timeout 300 postgres neo4j redis s3 || {
  "${COMPOSE[@]}" ps; "${COMPOSE[@]}" logs --tail=50; fail "services did not become healthy"; }
"${COMPOSE[@]}" up --exit-code-from s3-init s3-init || fail "bucket creation failed"

echo "== Postgres extensions"
EXT=$("${COMPOSE[@]}" exec -T postgres psql -U "${POSTGRES_USER:-diag}" -d "${POSTGRES_DB:-diag}" -At \
  -c "SELECT extname || '=' || extversion FROM pg_extension ORDER BY extname;")
echo "$EXT"
grep -q '^timescaledb=' <<<"$EXT" || fail "timescaledb extension missing"
VEC=$(grep '^vector=' <<<"$EXT" | cut -d= -f2) || fail "vector extension missing"
python3 - "$VEC" <<'PY' || fail "pgvector $VEC is older than 0.8.0 (needed for iterative index scans, A-ENG-7)"
import sys
v = tuple(int(x) for x in sys.argv[1].split(".")[:3])
sys.exit(0 if v >= (0, 8, 0) else 1)
PY

echo "== Neo4j + APOC"
"${COMPOSE[@]}" exec -T neo4j cypher-shell -u neo4j -p "$NEO4J_PW" "RETURN apoc.version() AS apoc;" \
  || fail "APOC not available"

echo "== Redis"
[ "$("${COMPOSE[@]}" exec -T redis redis-cli ping)" = "PONG" ] || fail "redis did not answer PONG"

echo "== S3 bucket"
# Capture first, then match: piping into `grep -q` can SIGPIPE the producer and, under
# pipefail, fail the gate even when the bucket exists.
BUCKETS=$("${COMPOSE[@]}" run --rm --no-deps --entrypoint /bin/sh s3-init -c \
  "echo 's3.bucket.list' | weed shell -master=s3:9333 -filer=s3:8888") || fail "could not list buckets"
echo "$BUCKETS"
grep -q -- "$BUCKET" <<<"$BUCKETS" || fail "bucket $BUCKET not found"

echo "GATE PASS: postgres (timescaledb, vector $VEC), neo4j (apoc), redis, s3 bucket $BUCKET"

if [ "${1:-}" = "--down" ]; then "${COMPOSE[@]}" down -v; fi
