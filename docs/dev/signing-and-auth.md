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
