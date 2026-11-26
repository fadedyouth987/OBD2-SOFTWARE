# Incident Response & Operations Runbook (Task 5.2, A-CEO-5)

## Runbooks by alert

| Alert | Runbook |
| --- | --- |
| StripeWebhookSignatureFailures, StripeWebhookNotApplied | [stripe-webhook-failures.md](stripe-webhook-failures.md) |
| SyncBacklog | [sync-backlog.md](sync-backlog.md) |
| DiagnoseFallbackRate | [diagnose-fallback.md](diagnose-fallback.md) |
| SchematicIngestFailureRate | [schematic-ingest-failures.md](schematic-ingest-failures.md) |
| ApiErrorBudgetFastBurn, ApiErrorBudgetSlowBurn | [api-error-budget.md](api-error-budget.md) |

Operations: [signing-key-rotation.md](signing-key-rotation.md), [daemon-rollback.md](daemon-rollback.md), [hil-release-checklist.md](hil-release-checklist.md).
Alert rules: `infra/monitoring/alerts.yml`. Every API log line is JSON with a `request_id`; the web app sends `X-Request-ID`, and the API returns it on every response.

## 1. Edge Daemon Refuses Gated Commands (`SAFETY_BLOCKED` / `PRECONDITION_UNKNOWN`)
- Confirm vehicle is stationary (`PID 0x0D == 0 km/h` sampled within 2 s).
- For Tier B commands (`UDS 0x10 0x02`, `0x34–0x3D`), confirm engine is off (`RPM == 0`) and battery maintainer is supplying `>= 12.5 V`.
- Never bypass `SafetyInterlock::check()`.

## 2. Cloud API Residency Violation at Startup
- `services/cloud-api` fails fast unless `AWS_REGION=ap-southeast-2`. Verify deployment environment variables before restarting.

## 3. Offline Edge-Lease Expiry (72h TTL)
- Reconnect tablet/workstation to internet and call `POST /api/v1/auth/edge-lease` to refresh the Ed25519 JWT (`PINNED_KID: cloud-2026-11`).
