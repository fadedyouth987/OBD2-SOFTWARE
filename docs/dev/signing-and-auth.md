# Local signing, auth, and key pinning

The cloud API signs edge leases, pairing tokens, and session JWTs with an
Ed25519 seed from `CLOUD_SIGNING_PRIVATE_KEY_HEX`. If that variable is missing
or invalid, signing and verification fail closed (no HMAC fallback, no baked-in
development seed).

Generate a local seed (never commit it):

```bash
python3 -c "import os; print(os.urandom(32).hex())"
```

Put it in `.env` along with `AUTH_ALLOW_DEV_LOGIN=true` for this machine only
and a `STRIPE_WEBHOOK_SECRET` (any `whsec_...` string for local tests). Then:

```bash
curl -s -X POST http://127.0.0.1:8000/api/v1/auth/dev-session \
  -H 'content-type: application/json' -d '{}'
```

Use the returned `access_token` as `Authorization: Bearer ...` on lease,
pairing, session sync, diagnosis, billing, gateway, and VIN-decode routes.
Tenant, user, tier, and AASRA status are always loaded from Postgres for that
session; request bodies cannot set them.

`POST /api/v1/auth/dev-mark-aasra` (also gated by `AUTH_ALLOW_DEV_LOGIN`) is the
only local way to flip `tenants.aasra_verified`. The AASRA verifier does not
trust client `aasra_verified` / `vsp_authorized` flags. Replace it with the
real AASRA/OEM integration before production.

`apps/edge-daemon/src/auth/cloud_keys.rs` must stay empty unless you
deliberately pin the *public* half of a production key with
`scripts/export_cloud_keys.py`. An empty list is the safe default: the daemon
stays COMMUNITY and ignores cloud-issued leases.

`IMMO_FEATURE_ENABLED` (default false) gates immobilizer routes. A short-lived
`immo_lease` (`aud=edge-daemon`, `lease_kind=immo_lease`, 15 minutes, 30-minute
cap) is issued only when the tenant is AASRA-verified, the technician is
accredited, and an owner authorisation for that VIN exists. The sandbox OEM
adapter issues a fake SecurityAccess token only when `AUTH_ALLOW_DEV_LOGIN=true`.
The secret is never stored. Put the lease in `$EDGE_DATA_DIR/immo_lease.jwt` so
the daemon can bind it on connect. See `docs/design/immobilizer-key-programming.md`.


`just dev` sources the repo-root `.env` before starting uvicorn so Settings
can read `STRIPE_WEBHOOK_SECRET`, Stripe price IDs, and the signing key even
though the API process cwd is `services/cloud-api`.

`POST /api/v1/auth/dev-grant-plan` (also dev-only) sets the tenant's plan and
optional IMMO add-on for local demos.

## Plans and Stripe

Tiers (AUD, annual is 10-for-12): Community $0 (1 seat, 5 AI diagnoses, no
schematics, no paid edge features); Pro $39 / $390 (UDS_ACTIVE, 1 seat, 100
AI, 25 schematic pages); Workshop $99 / $990 (UDS_ACTIVE, CAN_RE_PRO, J2534,
5 seats, 400 AI, 100 pages); Fleet $229 / $2,290 (same features, 10 seats,
3 sites, 1,000 AI). The IMMO add-on is $49 / $490 on Workshop and Fleet only
and still requires AASRA, technician accreditation, and OEM policy.

Create those products in the Stripe Dashboard (AUD) and set:

```
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_PRO_MONTH=
STRIPE_PRICE_PRO_YEAR=
STRIPE_PRICE_WORKSHOP_MONTH=
STRIPE_PRICE_WORKSHOP_YEAR=
STRIPE_PRICE_FLEET_MONTH=
STRIPE_PRICE_FLEET_YEAR=
STRIPE_PRICE_IMMO_MONTH=
STRIPE_PRICE_IMMO_YEAR=
```

Optional: `STRIPE_PRICE_SEAT`, `STRIPE_PRICE_SITE`, `STRIPE_PRICE_AI_OVERAGE`,
`STRIPE_AI_OVERAGE_ENABLED=false`, `STRIPE_PAST_DUE_GRACE_DAYS=7`,
`PUBLIC_APP_URL`. Checkout and the Customer Portal are Owner-only and return
HTTP 503 if the needed price ID or secret key is missing.

The webhook (`POST /api/v1/billing/webhook` or `/api/v1/billing/stripe/webhook`)
maps tenants by `stripe_customer_id` / `stripe_subscription_id` (with
`client_reference_id` as the first-time bind) and maps plan changes from
price IDs, not from event metadata. Failed applies return a non-2xx status so
Stripe retries. `invoice.payment_failed` moves the tenant to `past_due` with a
grace period, then degrades to Community and increments `lease_version`.

Paid-feature diagnostic leases last 12 hours (Community stays 72 h) and carry
`lease_ver` and optional `rcid`. The daemon compares `rcid` to `EDGE_DEVICE_ID`
when set, refuses generations below `EDGE_LEASE_MIN_VERSION` or
`$EDGE_DATA_DIR/lease.min_ver`, streams raw CAN only when `CAN_RE_PRO` is
granted, and closes open WebSockets when `lease.jwt` or the min version file
changes. Quota months follow the calendar in Australia/Adelaide; the increment
is an atomic `UPDATE … RETURNING`. The public diagnose API does not accept a
client `llm_error` skip.
