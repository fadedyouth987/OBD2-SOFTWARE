# Schematic ingest failures

Alert: **SchematicIngestFailureRate** (ticket). Metrics: `obd2_schematic_ingest_failures_total{reason}`, `obd2_schematic_uploads_total`.

## What it means

More than 10% of schematic uploads failed in the last hour (at least 4 failures).

| `reason` | Meaning | Usually |
| --- | --- | --- |
| `storage` | The file couldn't be written to S3 | An outage or credentials problem: act on this first |
| `unreadable` | The PDF is corrupt, encrypted or has no pages | Customer files; check if one workshop is retrying the same file |
| `too_many_pages` | Over the 200-page limit (A-ENG-8) | Not counted by the alert; the message tells the user to split the file |

## Check and fix

1. **storage**: check the bucket (`S3_BUCKET`, `S3_ENDPOINT_URL`) and the API's credentials. Uploads are refused before any pages are charged, so customers lose nothing; ask them to retry once storage is back.
2. **unreadable**: find the request IDs in the access log (`route="/api/v1/schematics"`, status 422). If many workshops hit it after a dependency update, suspect the PDF library (`pypdf`) and roll back.
3. **Worker pages**: the ingest worker marks a page that crashes or runs past `AI_WORKER_PAGE_TIMEOUT_S` (default 60 s) as failed and continues; the task result lists them under `failed_pages`, with the API `request_id` on the worker log line. A worker that runs out of memory (`AI_WORKER_MEMORY_MB`, default 1024) is replaced by Celery; repeated replacement points to a hostile file.
