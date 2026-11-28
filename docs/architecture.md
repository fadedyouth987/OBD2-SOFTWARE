# Architecture

Status: Release 1 (Tasks 0.1 to 5.1) built, plus the Android app (Phase 6, in progress). The desktop diagram comes from the 2026-11-19 gstack plan review; the phone diagram from docs/design/mobile-app.md.

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

The Android app (`apps/mobile`, read-only in release 1) talks to the car directly, without the daemon:

```
 Phone (Expo app)                                      AWS ap-southeast-2
 ┌──────────────────────────────────────────┐ HTTPS   ┌──────────────────────────────┐
 │ screens ─ plan access (plan_features)    │────────▶│ cloud-api: auth/me, jobs,    │
 │ send guard: allow-list + safety_policy   │         │ diagnose, report data        │
 │ ELM327 driver ─ frame parser ─ reads     │         └──────────────────────────────┘
 │ transports: BLE │ classic SPP │ demo car │
 └───────────────┬──────────────────────────┘
                 │ Bluetooth ─ ELM327 dongle ─ OBD-II
               Vehicle
```

Plans and what each unlocks live in `packages/schemas/plan_features.json`; `billing.py`, `signing.py`, the web billing page and the app all read it. Design and review: `docs/design/mobile-app.md`.

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
