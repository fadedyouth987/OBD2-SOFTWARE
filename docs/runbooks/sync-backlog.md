# Sync backlog

Alert: **SyncBacklog** (ticket). Metric: `obd2_sync_lag_seconds` (summary: how long after its watermark a batch reached the API), `obd2_sync_batches_total{outcome}`.

## What it means

Edge batches (telemetry and the gated-command audit) are arriving more than 15 minutes after they were recorded, on average. Workshops can keep working offline; the audit trail in the cloud is just late.

## Check

1. **Is it a few workshops or everyone?** A handful of workshops reconnecting after a long offline period raises the average without anything being wrong. If `rate(obd2_sync_batches_total[15m])` is normal and the lag is falling, wait.
2. **Is the API slow to accept?** Look at `obd2_http_request_duration_seconds` for `route="/api/v1/sessions/sync"` and at 5xx on that route. Slow inserts usually mean database pressure: check Postgres CPU, locks and connection pool exhaustion (`db_pool_size`, `db_max_overflow`).
3. **Are batches being refused?** 409 `session sync conflict` means two writers raced on one batch; the edge retries and the second attempt is deduplicated by `batch_id`.

## Fix

- Database pressure: scale the database or raise the pool for the API's role, then watch the lag fall.
- Edge clock skew makes lag look huge or negative; lags over 30 days are ignored by the metric. If one workshop's clock is wrong, tell them to fix it.
- Nothing is lost while the backlog drains: the daemon never evicts unsynced rows (A-ENG-9) and each batch is idempotent.
