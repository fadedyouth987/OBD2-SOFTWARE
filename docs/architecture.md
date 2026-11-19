# Architecture

Status: Task 0.1 (scaffold). Diagrams come from the 2026-11-19 gstack plan review and describe the target system; components are filled in task by task.

## System

```
 Workshop PC                                         AWS ap-southeast-2
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────────┐
 │ Browser (Next.js app)                    │ HTTPS │ cloud-api (FastAPI)              │
 │   edge-client ──ws://127.0.0.1:8765──┐   │──────▶│  auth: lease + pairing (Ed25519) │
 └──────────────────────────────────────┼───┘       │  sessions/sync ─▶ TimescaleDB    │
 ┌──────────────────────────────────────▼───┐       │                 └▶ S3 (traces)    │
 │ edge-daemon (Rust service)               │       │  diagnose ─▶ pgvector · Neo4j ─▶ LLM
 │  ws server ─ pairing ─ lease verifier    │──sync▶│  billing (Stripe webhook)        │
 │  SafetyInterlock ◀── safety_policy.json  │       │  gateways (AASRA, AutoAuth)      │
 │  DiagTransport: ISO-TP │ K-line │ ELM    │       └──────────────┬───────────────────┘
 │  HAL: SLCAN STN FTDI SocketCAN ──┐       │                      │ Celery
 │  j2534-bridge (32-bit process) ◀─┘       │               ┌──────▼──────────┐
 │  SQLite WAL ring buffer + audit log      │               │ ai-worker       │
 └───────────────┬──────────────────────────┘               │ schematic ingest│
                 │ OBD-II / K-line / CAN                     └─────────────────┘
               Vehicle
```

## Safety token lifecycle

```
 NONE ──SafetyConfirmRequest (preconditions OK, lease OK)──▶ ISSUED(60 s, bound)
 ISSUED ──DiagCommandRequest w/ matching binding──▶ CONSUMED (single use)
 ISSUED ──expiry / disconnect / mode→SILENT──▶ REVOKED
 ISSUED ──binding mismatch──▶ refused TOKEN_INVALID; token stays ISSUED until expiry
 CONSUMED ──any reuse──▶ refused TOKEN_INVALID      [impossible: CONSUMED→ISSUED]
```

## Deployment target

Production runs in AWS ap-southeast-2. The cloud API refuses to start in any other region while `DATA_RESIDENCY_ENFORCE=true` (`services/cloud-api/app/config.py`).

## Decisions made in Task 0.1

| Decision | Why |
| --- | --- |
| SeaweedFS replaces MinIO as the local S3 stand-in | MinIO stopped publishing community images in October 2025 and removed `minio/minio` from Docker Hub. Code uses a generic `S3_ENDPOINT_URL`, so this is local-only and swappable. |
| System font stack in the web app | `next/font/google` needs network access at build time; DESIGN.md (A-DES-5) chooses type before Task 4.1. |
| JSON Schema in `packages/schemas` is the source of truth for wire types | Eng review decision d3; codegen arrives in Task 0.2. |
