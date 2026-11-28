# Signing-key rotation

The API signs edge leases and pairing tokens with an Ed25519 key (`CLOUD_SIGNING_PRIVATE_KEY_HEX`, key ID `CLOUD_SIGNING_KID`). Daemons verify them against the public keys pinned in `apps/edge-daemon/src/auth/cloud_keys.rs`. Rotate yearly, and at once if the private key may have leaked.

Leases last at most 72 hours (12 hours for paid features), so the overlap only needs to cover one daemon release plus 72 hours.

## Planned rotation

1. **Make the new key** in the secret manager (never on a laptop, never in the repo). Record its public half and pick a new key ID, e.g. `cloud-2027-05`.
2. **Ship a daemon that trusts both keys**, newest first:
   ```bash
   python3 scripts/export_cloud_keys.py --key cloud-2027-05=<new public hex> --key cloud-2026-11=<old public hex> \
     --kotlin-out apps/android/app/src/main/java/au/com/rootcauseobd/fleet/data/CloudKeys.kt
   ```
   `--kotlin-out` pins the same keys in the Android app, which checks the plan licence the same way. Release the app alongside the daemon.
   Run the HIL checklist, release, and wait until `obd2_daemons_seen` shows the old daemon version gone (or below the agreed threshold). Android users who haven't updated stay on the plan they have until their licence expires, then fall back to Community until they update.
3. **Switch the API**: set `CLOUD_SIGNING_PRIVATE_KEY_HEX` to the new private key and `CLOUD_SIGNING_KID=cloud-2027-05`, then restart. New leases use the new key; daemons from step 2 accept them.
4. **Wait 72 hours** so every lease signed by the old key has expired.
5. **Drop the old key** from the daemon (`export_cloud_keys.py --key cloud-2027-05=<new public hex>`) in the next release, and destroy the old private key in the secret manager.

## Emergency rotation (key may have leaked)

1. Do steps 1 and 3 at once, then release a daemon that pins **only** the new key as soon as it passes the HIL checklist.
2. Bump every workshop's `lease_version` so daemons drop leases issued before the switch (daemons refuse leases below `EDGE_LEASE_MIN_VERSION`).
3. Until the new daemon is installed, workshops fall back to Community (read-only) features. Tell them why.
