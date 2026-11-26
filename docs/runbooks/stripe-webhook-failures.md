# Stripe webhook failures

Alerts: **StripeWebhookSignatureFailures** (page), **StripeWebhookNotApplied** (ticket).
Metric: `obd2_stripe_webhook_failures_total{reason}`.

## What it means

| `reason` | Meaning |
| --- | --- |
| `bad_signature`, `bad_payload` | The `stripe-signature` header didn't verify against `STRIPE_WEBHOOK_SECRET`, or the body isn't a Stripe event. The request is refused with 400 and nothing changes. |
| `tenant_lookup`, `unknown_customer` | The event verified but its customer or subscription isn't linked to a workshop. The API returns 5xx so Stripe retries. |
| `apply` | The event verified and matched a workshop but couldn't be applied. 5xx, so Stripe retries. |

## Signature failures (page)

1. Check whether the secret was rotated recently: Stripe Dashboard → Developers → Webhooks → the endpoint → **Signing secret**. If it was, set the new value as `STRIPE_WEBHOOK_SECRET` and restart the API.
2. If the secret is right, the traffic is forged or misrouted. Look up the request IDs in the access log (`route="/api/v1/billing/webhook"`, `status=400`) and the source IPs at the load balancer. Stripe's documented webhook IPs are on its site; block anything else at the edge.
3. Forged events never change a plan: verification happens before anything is read. No customer action is needed.

## Events not applied (ticket)

1. Find the event ID in the API logs (`Stripe event <id> apply failed`) and open it in the Stripe Dashboard.
2. `unknown_customer`: the customer was created outside Checkout. Link it to the workshop, or ignore if it's a test customer.
3. `apply`: read the exception in the log line with the same `request_id`. Fix, then use **Resend** on the event in the Dashboard. Event IDs are idempotent, so resending is safe.
4. Stripe retries for up to 3 days. A plan stays as it was until the event applies.
