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

# Start local infrastructure in the background
infra-up:
    docker compose -f infra/docker-compose.yml --env-file .env up -d --wait

# Stop local infrastructure (add `-v` to also delete data: just infra-down -v)
infra-down *args:
    docker compose -f infra/docker-compose.yml --env-file .env down {{args}}

# Task 0.1 Verification Gate
infra-gate *args:
    scripts/infra-gate.sh {{args}}

# Start infrastructure, then the web app and API with live reload
dev: infra-up
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill 0' EXIT
    (cd services/cloud-api && uv run uvicorn app.main:app --reload --port 8000) &
    (cd apps/web && pnpm dev) &
    wait

# Run every test suite
test:
    cargo test --workspace --locked
    cd services/cloud-api && uv run pytest -q
    cd services/ai-worker && uv run pytest -q
    cd apps/web && pnpm typecheck

# Lint and format checks across all languages
lint:
    cargo fmt --all --check
    cargo clippy --workspace --all-targets --locked -- -D warnings
    cd services/cloud-api && uv run ruff check . && uv run ruff format --check .
    cd services/ai-worker && uv run ruff check . && uv run ruff format --check .
    cd apps/web && pnpm lint

# Production builds
build:
    cargo build --workspace --release --locked
    cd apps/web && pnpm build
