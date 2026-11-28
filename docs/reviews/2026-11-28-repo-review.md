# OBD2-SOFTWARE repo review — 28 Nov 2026 (ACDT)

**Scope:** `origin/main` from `9a8e575` (our ui-ux-wiring) to `ecb38de` — 24 commits (PRs #11, #12, #13, which Claude wrote, plus direct pushes `a9eb957` and `ecb38de` by fadedyouth987). Open PR #14 (`claude/fervent-goldberg-j9n8fk`, head `3a3177b`) is reviewed separately. This was a review only: nothing was pushed, merged or commented, and no settings were changed.

**Counts:** 0 critical · 3 high · 9 medium · 8 low

## Verdicts
- **main:** red. CI has failed on every push since the PR #13 merge (`8c1ec9f`). Since `a9eb957` the lint step fails, so CI hasn't run any API, worker, web or e2e tests on the latest two commits.
- **PR #14:** fix first. The code is good and all its CI is green, and merging it fixes two of main's three red checks. Before merging, decide between the two Android apps, approve the new MOBILE tier at $15/mo, and add the one-line ruff format fix. Without that fix, main stays red after the merge.

## High
**H1. main CI is red, and the latest commits weren't tested in CI.**
- `8c1ec9f` (PR #13 merge) went in with two failing checks:
  - The Windows MSI build fails: `WIX0004 FailureActionsWhenNonFatalExitCodes` at `apps/edge-daemon/packaging/windows/edge-daemon.wxs:36`.
  - Playwright `e2e/session-flow.spec.ts:31` fails: after a reload, "Disconnect" doesn't stick and the vehicle reconnects.
- `a9eb957` broke lint: `ruff format` on `services/ai-worker/app/vision/schematic_pipeline.py:29-30`.
  - The `quickstart` job stops at `just lint`.
  - So for `a9eb957` and `ecb38de`, no tests or builds ran in CI after lint.
- Both direct pushes skipped PR review.
- Fix:
  - Run `uv run ruff format` in `services/ai-worker`.
  - Merge PR #14 (`bf3e5bf`/`c98a7c5` fix the WiX file and `1a3e052` fixes the reload).
  - Turn on branch protection that requires `quickstart` and `package`.

**H2. Release installers can't be built from main.**
- With the WiX error, `package.yml` → `windows` fails, so main can't produce a Windows MSI. Linux builds fine.
- `docs/status.md:140` still says package and quickstart are green and Task 5.1 is "gate verified".
- Fix: merge PR #14's WiX changes, then correct the status doc.

**H3. Google sign-in silently links existing accounts by email, a takeover risk.**
- Location: `services/cloud-api/app/services/oidc.py:356-381`, plus `config()` at `:92-102`.
- With `GOOGLE_CLIENT_ID` set, any Google account whose ID token has a matching `email` and `email_verified=true` is linked to an existing password account with no linked SSO. That includes Owners and platform admins.
- The link happens with no password check and no notification.
- For non-Gmail addresses, Google's `email_verified` doesn't prove the person still owns the address. Former staff, an expired domain, or a shared mailbox are all ways in.
- The Cognito path had the same logic, but Cognito is your own user pool; Google is a public identity provider.
- The Google path has no tests and no docs.
- Fix:
  - Only auto-link `@gmail.com` addresses, or a Workspace `hd` on an allow-list. Otherwise require the account's password (or an emailed one-time link) before linking.
  - Email the account owner when a link happens.
  - Add tests for the Google path.

## Medium
**M1. Two Android apps with opposite safety designs.**
- main's `apps/android` (Kotlin, `ecb38de`) sends Mode 04 "Clear DTCs" straight over Bluetooth. It runs its own copy of the safety rules (`data/SafetyPolicy.kt`) and doesn't use the daemon interlock, the audit log or lease entitlements.
- PR #14's `apps/mobile` (Expo) is read-only by design, with an allow-list send guard that checks `safety_policy.json`.
- They are different apps with different package ids (`au.com.rootcauseobd.fleet` vs `.mobile`).
- Fix: pick one. Recommended: keep `apps/mobile` read-only, and send all writes through the daemon.

**M2. Android Bluetooth client can mix up commands and show wrong fault codes.**
- `BluetoothObdClient.kt:97-104` sends the init and `STI` commands outside `ioMutex`, so `readDtcs`/`clearDtcs` can interleave with them.
- `ElmProtocol.kt:118-121` decodes from the first `0x43` byte and merges replies from several ECUs (headers off). The result can be phantom or missing codes.
- Fix:
  - Lock every send.
  - Turn headers on (`ATH1`) and parse per ECU, as the daemon and PR #14 do.

**M3. Android "edge daemon" mode can't work on a real phone.**
- It connects to `ws://127.0.0.1:8765` (`EdgeProtocol.kt:16`), and cleartext is only allowed to localhost and `10.0.2.2` (`network_security_config.xml`).
- The daemon listens on the PC's loopback, so only an emulator or `adb reverse` works.
- After the safety confirm, `MainActivity.kt:590` flips the mode locally, but the adapter stays connected in SILENT (`:359`), so the daemon refuses the token.

**M4. The Android Kotlin app isn't built or tested anywhere.**
- No workflow covers `apps/android`.
- `compileSdk 37` with AGP 9.5.1 has never been built.
- The unit tests (`EdgeProtocolTest`, `ElmProtocolTest`, `SafetyPolicyTest`) have never run.
- The Gradle wrapper jar checksum matches the official 9.6.0 release (verified).

**M5. Embedding backend: mislabelled vectors, no residency check, and no fallback.**
- Location: `services/cloud-api/app/services/embeddings.py:17-57`.
- `active_embedding_model()` is never used: rows are still labelled `bge-small…` (`jobs.py:437`, `sessions.py:496`).
- Turning on `EMBEDDING_BACKEND_URL` mixes vector spaces in the similar-case search (`sessions.py:139`). `.env.example` sets `EMBEDDING_MODEL=all-MiniLM-L6-v2`.
- Nothing checks that the URL is https or in ap-southeast-2, even though the docstring says it is.
- `urllib` errors aren't caught, so close-out and sync return 500. The 10-second blocking call also runs inside the request.

**M6. The schematic page timeout doesn't stop the work.**
- Location: `services/ai-worker/app/vision/schematic_pipeline.py:41-49`.
- On Windows, and now also on Linux worker threads that aren't the main thread, the thread-pool timeout raises `PageTimeout`, but the parse keeps running.
- A hostile PDF can tie up CPU and memory.
- Fix: run the parse in a subprocess with a hard kill.

**M7. The new 503 handler hides real database faults.**
- Location: `services/cloud-api/app/main.py:77-87`.
- It catches every `OperationalError` (deadlocks, serialization failures, statement and lock timeouts) and doesn't log it.
- It tells production users to "start Docker Desktop / PostgreSQL".
- Fix: log with the request ID, return a neutral message, and keep the dev hint for dev only.

**M8. Checkout can create a second subscription. This was already there before these commits.**
- Location: `services/cloud-api/app/api/v1/billing.py:104-180`.
- Nothing refuses checkout when the tenant already has an active `stripe_subscription_id`, so a paid workspace can be billed twice.
- Fix: send plan changes through the Customer Portal or subscription update.

**M9. PR #14 mobile sign-in is password-only.**
- Location: `apps/mobile/app/signin.tsx`, `src/api/client.ts:82`.
- Accounts made through Google or Cognito have no password, so those users can't sign in on mobile.
- Fix: add OIDC through the system browser (PKCE) before release.

## Low
- **L1. Google sign-in edge cases** (`oidc.py`):
  - ID tokens with `iss="accounts.google.com"` (no https) are rejected.
  - When `OIDC_ISSUER` is also set, Google is silently ignored.
  - `docs/dev/sign-in-oidc.md` doesn't mention Google.
- **L2. Android hygiene:**
  - `allowBackup` is on by default.
  - `BLUETOOTH_SCAN` is requested but unused (only paired devices are listed).
  - The RFCOMM connect can't be cancelled.
  - The safety tiers are hard-coded instead of read from `safety_policy.json`.
- **L3. Local pairing can be blocked.** Any local client can keep pairing locked by sending 5 wrong codes every 30 s (`apps/edge-daemon/src/server/pairing.rs`, `consume`). This only works from the same machine.
- **L4. Real-daemon e2e scripts hide failures.** `tools/e2e-real-daemon/*.mjs` exit 0 even when a step prints FAIL (`p2-team` ended on a locator error with exit 0).
- **L5. Old daemons and MOBILE leases (PR #14).** Older daemons reject a `MOBILE` lease and drop to COMMUNITY. This fails closed and is harmless, because MOBILE has no lease features.
- **L6. Workflow hardening.**
  - Actions are pinned by tag, not SHA.
  - Signing relies on a protected `release` environment that must exist with required reviewers.
- **L7. Repo size.** About 5.5 MB of Kickstarter video and images are committed in `docs/kickstarter/`. Consider Git LFS or a release asset.
- **L8. Spoofable audit actor (already there before these commits).** Synced audit rows take `user_ref` from the client (`sessions.py` `_audit_rows`), so a paired client can spoof the actor on audit entries. Fix: use `principal.user_id`.

## Checked and OK
- **Secrets:** none in the new commits or in PR #14. I scanned for Stripe, AWS, GitHub, Google keys, private-key headers and `.env` files. `cloud_tokens.json` is a documented test-only key (seed bytes 1..32), and only debug builds trust dev keys.
- **Migrations:**
  - The chain is linear, 001→012 with one head; PR #14 adds 013.
  - On a scratch Postgres 17 with Timescale and pgvector: `upgrade head` passed, and 013 went down and back up cleanly.
  - RLS with FORCE is on for `can_trace_outbox`.
- **Daemon handshake:**
  - `client_token`/`client_version` and protocol 1.1.0 are unchanged.
  - Leases per technician still work.
  - `end_session` now clears speed, RPM and battery, which is good.
  - Pairing now has a lockout.
  - Sim faults only work in debug builds.
- **Entitlements, Stripe and immobilizer:**
  - Billing and immobilizer tests pass.
  - Webhook failures now emit metrics.
  - Immobilizer gating (AASRA plus owner authorisation) is untouched, and there's no seed/key, PIN or cloning code.
- **Sync:** gzip sync is solid (auth before inflating, caps, one gzip member only). The CAN trace outbox commits before uploading.
- **Installers:**
  - Linux systemd hardening is good.
  - The Windows data ACLs are good.
  - Signing runs only on tags, in a separate environment.

## Tests I ran (scratch worktrees, Postgres 17 + Timescale + pgvector, Redis, SeaweedFS)
| Check | main `ecb38de` | PR #14 `3a3177b` |
|---|---|---|
| cargo fmt / clippy -D warnings | pass / pass | (CI pass) |
| cargo test (workspace) | 170 passed, 0 failed | (CI pass) |
| cloud-api pytest | 250 passed | 272 passed |
| cloud-api ruff | pass | pass |
| ai-worker pytest / ruff format | 9 passed / **FAIL (1 file)** | pass / pass |
| web typecheck, eslint, vitest | pass, pass, 146 passed | pass, pass, 132 passed (tests moved to packages/core) |
| packages/core, apps/mobile | n/a | 23 passed, 160 passed |
| web build | pass | (CI pass) |
| Playwright (`pnpm e2e`) | 27 passed, **1 failed** (reload/disconnect) | (CI pass) |
| tools/e2e-real-daemon (full local stack + debug daemon) | p0 ✓, p1 ✓, p2-files ✓, a11y 20 views clean, p2-team: product steps ✓, last check failed on the test's own locator | — |
| Android Kotlin | not built (no SDK, no CI) | — |

## CI (gh run list)
| Commit | quickstart | package |
|---|---|---|
| 147503f (PR #12 merge) | ✓ | ✓ |
| 8c1ec9f (PR #13 merge) | ✗ e2e reload | ✗ Windows WiX |
| a9eb957 (direct push) | ✗ lint | ✗ Windows WiX |
| ecb38de (direct push) | ✗ lint | ✗ Windows WiX |
| PR #14 3a3177b | ✓ | ✓ (+ mobile ✓) |

## Recommended order
1. Run `ruff format` on the ai-worker file and turn on branch protection on main that requires `quickstart` and `package`.
2. Make the PR #14 decisions (which Android app; MOBILE tier price), then merge it. That fixes the WiX and reload failures.
3. Put Google auto-linking behind a password or emailed confirmation (H3), and add tests.
4. Fix the 503 handler, the embeddings labelling and fallback, the worker timeout, and the checkout guard.
5. Update `docs/status.md`: Actions does run now, main is red, and the Google and Android work is missing from it.
