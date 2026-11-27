# Developer commands (A-DX-1). Run `just` to list them.
set dotenv-load := false

default:
    @just --list

# Install every workspace's dependencies (pnpm, uv, cargo)
bootstrap:
    pnpm install --frozen-lockfile
    cd services/cloud-api && uv sync --frozen
    cd services/ai-worker && uv sync --frozen
    cargo fetch --locked
    @test -f .env || (cp .env.example .env && echo "Created .env from .env.example")

# Start local infrastructure in the background. The long-running services are
# waited on by name: `up --wait` counts the one-shot s3-init exiting (even with
# code 0) as a failure on some Compose versions. s3-init then runs on its own,
# and its exit code is the step's, as in scripts/infra-gate.sh.
infra-up:
    docker compose -f infra/docker-compose.yml --env-file .env up -d --wait --wait-timeout 300 postgres neo4j redis s3
    docker compose -f infra/docker-compose.yml --env-file .env up --exit-code-from s3-init s3-init

# Stop local infrastructure (add `-v` to also delete data: just infra-down -v)
infra-down *args:
    docker compose -f infra/docker-compose.yml --env-file .env down {{args}}

# Task 0.1 Verification Gate
infra-gate *args:
    scripts/infra-gate.sh {{args}}

# Start infrastructure, then the web app and API with live reload.
# The root .env is exported so cloud-api Settings (webhook secret, price IDs,
# signing key) are visible even though uvicorn's cwd is services/cloud-api.
dev: infra-up
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT="{{justfile_directory()}}"
    if [[ -f "$ROOT/.env" ]]; then
      set -a
      # shellcheck disable=SC1091
      source "$ROOT/.env"
      set +a
    fi
    trap 'kill 0' EXIT
    (cd services/cloud-api && uv run uvicorn app.main:app --reload --port 8000) &
    (cd apps/web && pnpm dev) &
    wait

# Regenerate Rust types, Zod validators and docs/protocol.md from packages/schemas (A-DX-3)
codegen:
    cargo run -q -p codegen --locked
    pnpm --filter @obd2/schemas codegen

# Fail if any generated file is out of date with packages/schemas (CI drift gate)
codegen-check:
    cargo run -q -p codegen --locked -- --check
    pnpm --filter @obd2/schemas codegen:check

# Run every test suite
test:
    cargo test --workspace --locked
    cd services/cloud-api && uv run pytest -q
    cd services/ai-worker && uv run pytest -q
    cd packages/core && pnpm typecheck && pnpm test
    cd apps/mobile && pnpm typecheck && pnpm test
    cd apps/web && pnpm typecheck
    cd apps/web && pnpm test

# Web end-to-end tests: the A-DES gates and the Task 4.1 gate against the real
# debug daemon (builds both first; no infrastructure needed)
e2e:
    cargo build -p edge-daemon --locked
    cd apps/web && pnpm build && pnpm e2e --trace off

# Lint and format checks across all languages, plus generated-code drift
lint: codegen-check
    node scripts/check-web-deps.mjs
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cd services/cloud-api && uv run ruff check . && uv run ruff format --check .
    cd services/ai-worker && uv run ruff check . && uv run ruff format --check .
    cd apps/web && pnpm lint

# Production builds
build:
    cargo build --workspace --release --locked
    cd apps/web && pnpm build
