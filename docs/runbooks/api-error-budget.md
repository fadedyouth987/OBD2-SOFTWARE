# API error budget

Alerts: **ApiErrorBudgetFastBurn** (page: over 5% 5xx for 5 minutes), **ApiErrorBudgetSlowBurn** (ticket: over 1% for an hour).
Metric: `obd2_http_requests_total{route,status}` (routes are templates such as `/api/v1/jobs/{job_id}`, never raw IDs).

## Check

1. Which route? `topk(5, sum by (route) (rate(obd2_http_requests_total{status="5xx"}[5m])))`.
2. Pick a failing request ID from the JSON access log (`"status": 5xx`) and read the log lines with the same `request_id` for the exception type. The web app sends its own `X-Request-ID`, so a customer's screenshot time can be matched to their requests.
3. Common causes:
   - **Database down or pool exhausted**: every route fails together. Check Postgres health and connections.
   - **S3 down**: only file routes fail (`/api/v1/schematics`, `/api/v1/dbc`, accreditation evidence).
   - **Stripe events not applying**: `/api/v1/billing/webhook` returns 5xx on purpose so Stripe retries; see [stripe-webhook-failures.md](stripe-webhook-failures.md).
   - **A bad deploy**: errors start at the deploy time. Roll back the API image.

## After

Note the start, end and cause in the incident log, and how much of the month's 1% budget it used.
