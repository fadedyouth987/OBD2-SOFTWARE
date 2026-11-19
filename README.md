# OBD2 Diagnostics

AI-assisted vehicle diagnostics for Australian workshops: a local Rust edge daemon talks to the car, a Next.js app shows live data and safety-gated actions, and a FastAPI cloud backend (ap-southeast-2) handles sync, diagnosis and billing.

- Build plan: [`docs/PLAN.md`](docs/PLAN.md) (tasks run strictly in order; see Rule 1)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Build status and deferred gates: [`docs/status.md`](docs/status.md)
- Edge WebSocket protocol: [`docs/protocol.md`](docs/protocol.md) (generated from `packages/schemas/edge_ws.schema.json`)
- Plan review: [`docs/reviews/2026-11-19-autoplan-review.md`](docs/reviews/2026-11-19-autoplan-review.md)

## Quickstart

Prerequisites: Git, Docker, [just](https://just.systems), [rustup](https://rustup.rs) (the pinned 1.97.0 toolchain installs automatically), Node 22 with pnpm 10, and [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 itself). AI-assisted work in this repo also requires [gstack](https://github.com/garrytan/gstack); see `CLAUDE.md`.

```bash
just bootstrap     # install all dependencies, create .env from .env.example
just infra-gate    # start Postgres, Neo4j, Redis and S3 storage, then verify them
just test          # every test suite
just dev           # infrastructure + API (localhost:8000) + web app (localhost:3000)
```

Target: a fresh checkout reaches a passing `just infra-gate` within 15 minutes. CI checks this on every push (`.github/workflows/quickstart.yml`). Once Tasks 1.4 and 4.1 land, the target becomes the first live stream from the virtual vehicle.

No Docker? See [`docs/dev/no-docker.md`](docs/dev/no-docker.md).

## Layout

| Path | What | Stack |
| --- | --- | --- |
| `apps/edge-daemon/` | Vehicle adapters, diagnostic protocols, safety interlock, loopback WebSocket | Rust 1.97 |
| `apps/j2534-bridge/` | 32-bit process that loads J2534 vendor DLLs for the daemon (A-ENG-1) | Rust 1.97 |
| `apps/web/` | Technician web app | Next.js 15, TypeScript, Tailwind 4 |
| `services/cloud-api/` | Leases, pairing, session sync, diagnosis, billing | Python 3.12, FastAPI, Alembic |
| `services/ai-worker/` | Schematic ingestion and ML jobs | Python 3.12, Celery |
| `packages/schemas/` | Shared wire schemas, safety policy and error hints; source for generated Rust/Zod types (`just codegen`) | JSON Schema |
| `infra/` | Local infrastructure | Docker Compose |
| `tools/codegen/` | Generates Rust protocol types from `packages/schemas` | Rust 1.97 |

## Local services

| Service | Address | Dev credentials |
| --- | --- | --- |
| Postgres 16 + TimescaleDB + pgvector | `localhost:5432` | `diag` / `diag` |
| Neo4j 5 + APOC | `bolt://localhost:7687`, browser `localhost:7474` | `neo4j` / `diag-dev-password` |
| Redis 7 | `localhost:6379` | none |
| S3 (SeaweedFS stand-in) | `http://localhost:8333`, bucket `automotive-traces-au` | `diagdev` / `diagdevsecret` |

All ports bind to 127.0.0.1. These credentials are for local development only.
