# RootCause Mobile: phone app and Mobile plan

Status: **approved and partly built** (2026-11-28). The engineering review below recorded the owner's answers (D1-D8).
- Built: the Mobile plan and plan table (6.1), `packages/core` (6.2), the app shell, Bluetooth and ELM327 (6.3, 6.4), and the read features (6.5). A debug APK comes from CI (`mobile.yml`).
- Still to do: app refresh tokens and the OIDC app redirect, screen-off recording (foreground service), the Play release (6.6), and a real-dongle field test.
- Open decisions 1 to 5 in section 7 are still open.
- Progress is tracked in `docs/status.md`.

## What the owner asked for

- A phone app for people who diagnose with a phone and a Bluetooth OBD-II dongle.
- A new **Mobile** plan for them. Existing plans unlock their own features in the app, so nothing is sold twice.
- Every feature in the app is mapped to the plans that include it.
- The laptop web version keeps working exactly as it does today.
- Release 1 is **read-only**. Clearing codes and service functions are marked "desktop only" until release 2 brings the safety interlock to the phone.
- **Android first** (Bluetooth LE and classic Bluetooth ELM327 dongles). iOS comes later.
- **React Native / Expo**, sharing TypeScript code with the web app.
- A recommendation for rugged tablets that run only RootCause.

## 1. Plan and feature matrix

### The Mobile plan (proposed numbers, owner to confirm)

| | Community | **Mobile (new)** | Pro | Workshop | Fleet |
| --- | --- | --- | --- | --- | --- |
| Price (AUD / month) | 0 | **15** | 39 | 99 | 229 |
| Price (AUD / year) | 0 | **150** | 390 | 990 | 2,290 |
| AI diagnoses / month | 5 | **40** | 100 | 400 | 1,000 |
| Schematic pages / month | 0 | **0** | 25 | 100 | 100 |
| Seats | 1 | **1** | 1 | 5 | 10 |
| Desktop lease features | none | **none** | UDS_ACTIVE | UDS_ACTIVE, CAN_RE_PRO, J2534 | same as Workshop |

Mobile ranks between Community and Pro: going from Mobile to Pro is an upgrade, and from Pro to Mobile a downgrade. Mobile users can also sign in to the web app. There they get the same read-only experience as Community, with Mobile's AI quota.

### App features by plan (release 1)

`✓` included · `5/mo` quota · `—` not included, shown locked with the plan that unlocks it · `Desktop` shown as "Desktop only" with a short explanation.

| App feature | Community | Mobile | Pro | Workshop | Fleet |
| --- | --- | --- | --- | --- | --- |
| Connect a Bluetooth dongle (BLE and classic) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Read engine codes (stored, pending, permanent) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Readiness monitors | ✓ | ✓ | ✓ | ✓ | ✓ |
| VIN read and decode | ✓ | ✓ | ✓ | ✓ | ✓ |
| Freeze frame | ✓ | ✓ | ✓ | ✓ | ✓ |
| Live data (view) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Live data recording and CSV export | — | ✓ | ✓ | ✓ | ✓ |
| Vehicles and jobs, synced with the web app | ✓ | ✓ | ✓ | ✓ | ✓ |
| AI diagnosis | 5/mo | 40/mo | 100/mo | 400/mo | 1,000/mo |
| Customer report (share PDF from the phone) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Clear codes, service functions | Desktop | Desktop | Desktop | Desktop | Desktop |
| CAN Studio, J2534, key programming | Desktop | Desktop | Desktop | Desktop | Desktop |

Rows that already exist on the web keep the web's rule, so a plan never means two different things. The one row marked `—` for Community is a new, app-only feature. It gets a feature key (`MOBILE_RECORDING`) in the shared catalogue below.

### One source of truth for the matrix

- New file `packages/core/src/plan-features.ts`. It holds the table above as data: feature key, label, which plans include it, quota field, and `desktop_only`.
- The app's locked and desktop-only states, the web billing page's plan cards and the pricing copy all render from this file. Nothing hard-codes a plan name next to a feature.
- A cross-language fixture test (same pattern as the existing `packages/schemas/fixtures`) checks that `billing.py` `TIER_QUOTAS`, `signing.py` `TIER_DEFAULT_FEATURES` and `plan-features.ts` agree. CI fails if they drift.

## 2. Not breaking the laptop web version

| Area | Change | How we prove nothing broke |
| --- | --- | --- |
| `apps/mobile` | New workspace. The web app never imports it. | Separate CI job. |
| `packages/core` | New shared package of plain TypeScript (DTC library, VIN, OBD decoding, formatting; no React). Code moves out of `apps/web/src/lib`, and web imports switch to `@rootcause/core` in the same PR (D8). Plan data lives in `packages/schemas/plan_features.json` (D1). | Web unit tests, `next build` and the full Playwright suite run unchanged and must stay green. |
| `pnpm-workspace.yaml`, lockfile | Add `apps/mobile`. | A CI check fails if any package version the web app resolves changes. The app uses the latest stable Expo SDK with its own React (pnpm isolated installs); `packages/core` has no React dependency. |
| Cloud API | Additive only: a `MOBILE` value in the `subscription_tier` enum (Alembic migration, `ALTER TYPE … ADD VALUE`), a `TierQuota` row, Stripe price settings, tier rank, and a feature list with no lease features. No endpoint changes behaviour for existing plans. | Existing pytest suite unchanged, plus new tests for Mobile upgrade, downgrade, checkout and webhook. |
| Edge daemon | **No change in release 1.** A Mobile lease carries no features, the same as Community today. | `cargo test` unchanged. |
| Web UI | Additive: a Mobile card on the billing page, its label in `TIER_LABEL`, and "Get the Android app" on Home and Devices. | New Playwright cases. Existing cases unchanged. |
| `apps/android` (existing Kotlin prototype) | Left untouched in release 1. It uses demo data and a theme named after a competitor's brand, so it should not ship as is. Remove it once the new app reaches parity (owner to confirm). | Not built by CI today. |

## 3. Release 1 app architecture (Android, read-only)

```
 Phone (apps/mobile, Expo dev build — not Expo Go, Bluetooth needs native code)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ Screens: Sign in · Connect · Scan · Live · Vehicles/Jobs · Diagnose  │
 │          · Report · Plan                                             │
 │ ─────────────────────────────────────────────────────────────────── │
 │ @rootcause/core: plan-features · entitlements · DTC library · VIN   │
 │                  · OBD-II PID decode · formatting                    │
 │ ─────────────────────────────────────────────────────────────────── │
 │ OBD service: ELM327 driver (AT init, prompt parsing, retries)        │
 │   └─ Send guard: every frame is checked against                      │
 │      packages/schemas/safety_policy.json; gated → refused (Rule 3)   │
 │ ─────────────────────────────────────────────────────────────────── │
 │ Transports: BLE GATT (react-native-ble-plx) · Classic SPP            │
 │   (react-native-bluetooth-classic) · Fake transport + ELM emulator   │
 └───────────────┬──────────────────────────────────────┬───────────────┘
                 │ Bluetooth                            │ HTTPS (existing /api/v1)
          ELM327 dongle ── OBD-II port           cloud-api: auth, jobs, diagnose,
                                                 reports, billing/me
```

- **No daemon on the phone in release 1.** The app talks to the dongle directly. It sends only read services: OBD-II modes 01, 02, 03, 07, 09 and 0A.
- **Send guard (fail closed).** Even read-only, every outgoing request goes through one function that loads `safety_policy.json` and refuses anything gated. A test walks `fixtures/gated_set.txt` and proves each one is refused. This is the hook release 2 replaces with the Rust interlock.
- **Dongles.** BLE: the common ELM327 GATT layouts (FFF0/FFF1/FFF2, FFE0/FFE1) plus OBDLink and Vgate profiles, found by service discovery rather than hard-coded names. Classic: SPP UUID `00001101-0000-1000-8000-00805F9B34FB`. ELM init: `ATZ ATE0 ATL0 ATS0 ATH1 ATSP0`, with handling for clones that report fake versions, `NO DATA`, `STOPPED`, `BUS INIT…` and `CAN ERROR`.
- **Permissions.** Android 12+: `BLUETOOTH_SCAN` (`neverForLocation`) and `BLUETOOTH_CONNECT`. Android 8 to 11: location permission, which Android requires for Bluetooth scanning there. Each one is explained before the system prompt.
- **Sign-in.** Email and password via the existing `/auth/login`. SSO via the existing OIDC flow with PKCE and an app link back into the app. Tokens are stored in the Android Keystore (`expo-secure-store`), never in plain storage. App-only refresh tokens (new, additive) keep phone users signed in. They have a 30-day sliding expiry and rotate on every use. Reusing an old token revokes the chain, and tokens are revoked on seat removal, password change or sign-out. Web sessions stay 12 h.
- **Plan checks.** The app reads `/auth/me` (tier, entitlements, usage) and renders every feature from `plan-features.ts`. The server enforces quotas as it does for the web. The app only shows them, so a modified app gains nothing.
- **Privacy.** VINs are shown with the shared `redactVin` mask wherever the web masks them. Crash reports and logs carry no VIN, token or email.
- **Offline.** A scan works with no signal. Results queue locally and sync to the job when back online. AI diagnosis and reports need a connection.

## 4. Release 2: gated actions on the phone

- Split the daemon's safety core (`SafetyInterlock::check()`, policy loader, lease verification, audit log) into an `edge-core` library crate. The daemon keeps using it, with behaviour and tests unchanged.
- Build `edge-core` for Android (`aarch64-linux-android`, `x86_64-linux-android`) and expose it to the app as a native module (UniFFI). The phone then runs the **same Rust interlock and the same `safety_policy.json`** as the desktop. No TypeScript copy of the safety logic.
- Clear codes and service functions unlock per plan, from the existing lease features (`UDS_ACTIVE` for Pro and up), with an Ed25519 lease verified on the device. The speed, RPM and battery checks fail closed (Rule 5), and every attempt writes an audit row that syncs to `audit_log` (A-CEO-4).
- USB OTG VCIs for rugged tablets come in the same release, through `edge-core`.

## 5. Rugged tablets that run only RootCause

**Short answer: you don't need your own ROM.** The way to make a tablet that boots straight into RootCause, with no home screen, other apps, settings or way out, depends on the tablet.

### Android rugged tablets (Samsung Galaxy Tab Active, Zebra ET4x, Blackview/Oukitel): dedicated-device mode (recommended)

- Android Enterprise "dedicated device" mode is built into every certified Android device. It is not a container or a separate profile: **the whole tablet is locked to RootCause.**
- The tablet is factory-reset and provisioned by scanning a QR code (or zero-touch / Knox Mobile Enrollment for bulk orders). RootCause becomes the **device owner** and the **home app**, and runs in **lock task mode**.
  - Status bar, notifications, recent apps and settings are hidden.
  - The home button returns to RootCause.
  - The device can't be used for anything else or removed from management without RootCause's admin PIN.
- Updates are pushed silently through managed Google Play (a private app) or the management console.
- **Management options**, cheapest first:
  - Google's free Android Management API, with a small RootCause admin page;
  - Samsung Knox Configure / Knox Manage (Galaxy Tab Active);
  - Zebra StageNow (Zebra);
  - a commercial MDM (Esper, Scalefusion, Hexnode, Intune).
- **Why not a custom ROM:**
  - You need the manufacturer's board support package (kernel and drivers), which rugged OEMs rarely release.
  - You then own monthly security patches, OTA servers and signing keys forever.
  - You lose Google certification, and usually the warranty.
  - The result is still Android underneath. The lock-down is what makes it "only RootCause", and dedicated-device mode already does that.
- **When a custom image does make sense:** buying hundreds of white-label units from an ODM. They will flash a factory image with your boot logo and RootCause preinstalled as the locked home app. Negotiate that with the ODM. Don't build the ROM yourself.

### x86 rugged tablets (Getac, Panasonic Toughbook, Dell Rugged): Linux kiosk image, no Android at all

- These run full Linux. The existing desktop stack already does: the Task 5.1 systemd daemon plus the web app.
- Build an image (Ubuntu Core or Debian) that runs the edge daemon as a service. It auto-logs into a kiosk session (Cage + Chromium in kiosk mode) showing only RootCause. Updates are signed image or package updates.
- This gets the **full desktop feature set today**, including gated actions behind the existing Rust interlock and USB VCIs, without waiting for mobile release 2. J2534 stays Windows-only.

**Recommendation:** start with the Android app in dedicated-device mode on one rugged model (Galaxy Tab Active5 is the easiest, using Knox). If customers want the full workshop feature set on a rugged device sooner, build the Linux kiosk image for one x86 model. Both are tasks in Phase 8 below.

## 6. Where this fits in docs/PLAN.md

This is new scope. Rule 1 lists the current order (Release 1 → Task 2.3 → Task 4.2 → AI copilot). Changing Rule 1 needs the owner's approval, as uc1 did. Proposed: add **Phase 6 (Mobile release 1)** after Task 5.2, before Task 2.3. Phases 7 and 8 come after Phase 6.

### Phase 6: Mobile release 1 (Android, read-only)

| Task | Scope | Verification gate |
| --- | --- | --- |
| 6.1 Mobile plan | `MOBILE` tier: enum migration, `TierQuota`, rank, features `[]`, Stripe price settings (`STRIPE_PRICE_MOBILE_MONTHLY` / `_ANNUAL`), web billing card and labels, `packages/core/src/plan-features.ts`, cross-language parity fixture | pytest (Mobile checkout, webhook, upgrade to Pro, downgrade from Pro), parity fixture green, existing web Playwright suite unchanged |
| 6.2 Shared package | `packages/core` with DTC library, VIN, OBD decoding, formatting; web imports moved to it, old files deleted (D8) | Web unit + `next build` + full Playwright green; web's resolved dependency versions unchanged |
| 6.3 App shell | Expo dev build in `apps/mobile` (Android only): sign-in (password + OIDC PKCE), Keystore token storage, plan screen, navigation; CI job: lint, typecheck, Jest, `expo prebuild` + Gradle `assembleDebug` | Debug APK built in CI and uploaded as an artifact |
| 6.4 Bluetooth + ELM327 | BLE and classic transports, ELM327 driver, send guard from `safety_policy.json`, fake transport + ELM emulator for tests (Rule 2) | Driver tests on recorded transcripts from at least three dongle types; guard refuses every entry in `gated_set.txt` |
| 6.5 Read features | Codes, readiness, VIN, freeze frame, live data (+ recording/export), jobs sync with offline queue, AI diagnosis, report sharing | Entitlement matrix test: for each of the 5 plans, every feature is available, locked or desktop-only exactly as `plan-features.ts` says; Maestro flow on an Android emulator in CI against the fake transport |
| 6.6 Release | Play App Signing (upload key in the GitHub `release` environment, tag-only like Task 5.1), Play internal-testing track, privacy policy and Data safety form, crash reporting without VIN/email | Signed AAB on a tag; owner completes the field checklist on a real phone with a real dongle |

### Phase 7: Mobile release 2 (gated actions)

7.1 `edge-core` crate split (daemon unchanged) → 7.2 Android build + native module → 7.3 lease verification, interlock, audit sync on the phone → 7.4 clear codes and service functions per plan → 7.5 USB OTG VCIs.

### Phase 8: Rugged and iOS

8.1 Android dedicated-device provisioning (QR enrolment, lock task, home app, admin PIN, silent updates) on one model → 8.2 Linux kiosk image for one x86 model → 8.3 iOS (BLE dongles only; App Store review; Apple's in-app purchase rules apply).

## 7. Open decisions for the owner

1. **Mobile plan numbers:** A$15/month, A$150/year, 40 AI diagnoses, no schematics, 1 seat?
2. **Community in the app:** free users get the read features and 5 AI diagnoses (good funnel), with recording and report sharing locked?
3. **Selling inside the app:** Google Play requires its own billing for digital subscriptions bought inside an Android app. Release 1 proposal: the app only signs in and shows the plan, with no buy buttons. Plans are bought on the website. Adding Google Play Billing is a later task. Tablets provisioned through your own management console aren't affected.
4. **Rule 1 placement:** Phase 6 after Task 5.2, before Task 2.3?
5. **Old Kotlin prototype (`apps/android`):** delete once the new app reaches parity?

## 8. What can and can't be tested from this environment

- **Can:** all TypeScript (Jest), the API and web changes, the debug APK build (CI), and a Maestro run on an Android emulator in GitHub Actions against the fake dongle.
- **Can't:** real Bluetooth, real dongles and real cars. Release 1 ends with a short field checklist you run on your own phone with a real dongle: connect, scan, live data, report. Recorded dongle transcripts from that run become regression fixtures.
- Publishing needs a Google Play developer account (one-off US$25) and, later, an Apple developer account (US$99/year). Stripe price IDs for the Mobile plan are created in your Stripe dashboard. None of these go in the repo.

## Engineering review (gstack /plan-eng-review, 2026-11-27)

Target: this file, `docs/design/mobile-app.md`, sections 1 to 8 above as first drafted (the original plan stays unchanged above this heading). Report file: this file.

### Reality rows

| Premise | Claim | Receipt | Verdict |
| --- | --- | --- | --- |
| Password sign-in exists | `/auth/login` | `services/cloud-api/app/api/v1/auth.py:403` `@router.post("/login")` | true |
| OIDC with PKCE exists | `/oidc/start`, `/oidc/callback` | `auth.py:287`, `auth.py:292` "state, nonce and PKCE are set up here" | true |
| OIDC can return to an app | one redirect URI | `services/cloud-api/app/services/oidc.py:79` `s.oidc_redirect_uri` (single value) | false: needs a second, app-link redirect |
| Refresh tokens exist | "if the API has no refresh token" | `services/cloud-api/app/services/signing.py:29` `DEFAULT_SESSION_TTL_S = 12 * 3600`; no refresh route in `auth.py` | none: sessions end after 12 h |
| Report is a server PDF | "share PDF" | `services/cloud-api/app/api/v1/jobs.py:462-464` `"""Data for the printable customer report."""` returns `dict` | JSON only: PDF must be rendered on the phone |
| Report is plan-gated on web | matrix locks it for Community | `jobs.py:463` `def job_report(job_id: str, principal: RequirePrincipal)` (no tier check) | false: ungated today |
| Clear codes is gated | OBD mode 04 / 08 in policy | `packages/schemas/safety_policy.json` `"protocol": "OBD", "service_id": "0x04"` and `"0x08"` | true |
| Tier list is a Postgres enum | `ALTER TYPE … ADD VALUE` | `services/cloud-api/app/db/models.py:74-75` `Enum(SubscriptionTier, name="subscription_tier", create_type=False)` | true |
| Rank drives downgrades | Mobile between Community and Pro | `billing.py:29` `_TIER_RANK`, `billing.py:422` `downgrade = _TIER_RANK[new_tier] < _TIER_RANK[previous]` | true |
| Paid tiers list | Mobile must join it | `billing.py:24` `PAID_TIERS = frozenset({SubscriptionTier.PRO, SubscriptionTier.WORKSHOP, SubscriptionTier.FLEET})` | needs edit |
| Stripe price settings pattern | `stripe_price_<tier>_month/_year` | `services/cloud-api/app/config.py:44-53` | true (plan's env names must follow it: `stripe_price_mobile_month`, `stripe_price_mobile_year`) |
| Web uses React 19.1.0 | pin Expo to React 19.1 | `apps/web/package.json` `"react": "19.1.0"` | true, but React 19.1 means Expo SDK 54; current is SDK 56 on React 19.2 [web: expo.dev/changelog/sdk-56] |
| Expo supports pnpm monorepos | isolated installs | docs.expo.dev/guides/monorepos [web] | true |
| react-native-ble-plx does classic BT | no | library README [web] "does NOT support bluetooth classic" | plan already pairs it with a classic library |

unverified=0

```
REALITY: premise-table finding 3 false/changed premises (OIDC redirect, refresh token, report gating) services/cloud-api/app/services/oidc.py:79
REALITY: already-done pass origin/main has no apps/mobile, packages/core or mobile design since 2026-11-26 (git log origin/main) docs/design/mobile-app.md:1
REALITY: surface-check finding /auth/login and /oidc/* exist; no refresh route; /jobs/{id}/report returns JSON services/cloud-api/app/api/v1/jobs.py:462
REALITY: binding-decisions pass owner D1-D4 (Mobile plan, read-only R1, Android first, Expo) honoured; no branch decision overruled docs/design/mobile-app.md:5
REALITY: numbers finding prices and quotas are [estimated] proposals for owner approval; existing tier numbers [measured: billing.py:51-94] docs/design/mobile-app.md:24
REALITY: deferred-asks pass no linked issue; owner asks (no web regression, rugged answer, plan matrix) all addressed docs/design/mobile-app.md:5
REALITY: pr-count finding no .gstack/ship-policy.json; default one PR per wave; Phase 6 is six tasks, proposed as one PR per task (six gates) docs/design/mobile-app.md:146
REALITY: prior-art pass no vendored or patched dependency planned docs/design/mobile-app.md:64
REALITY: contract-assumptions finding assumed "Expo on React 19.1" is stale (SDK 56 / React 19.2) docs/design/mobile-app.md:64
REALITY: dependency-fallback pass Phase 6 needs nothing from Phases 7-8; 6.1 ships alone (web + API) docs/design/mobile-app.md:146
REALITY: obligation-tiers pass must-ship Phase 6; next Phase 7; deferred Phase 8 docs/design/mobile-app.md:146
REALITY: transaction-semantics n/a only an enum ADD VALUE migration, no driver or pool change services/cloud-api/app/db/models.py:75
```

### Scope Challenge findings

1. `[CRITICAL] (confidence: 9/10) docs/design/mobile-app.md:94` — The send guard is a deny-list of gated service IDs: "refuses anything gated". An ELM327 also accepts AT commands, and OBDLink dongles accept ST commands (for example raw-frame transmit). These send bytes the guard never parses as an OBD/UDS request, so a deny-list on the request payload can be bypassed. Release 1 needs an allow-list: the AT/ST init commands the driver uses, plus OBD modes 01, 02, 03, 07, 09 and 0A. Everything else is refused, and the `safety_policy.json` check stays as a second layer.
2. `[CRITICAL] (confidence: 9/10) docs/design/mobile-app.md:50` — The plan says rows that exist on the web keep the web's rule. But the customer report is ungated on the web (`jobs.py:463`, no tier check), and the matrix locks report sharing for Community. Either Community keeps reports in the app, or the web gains a new gate, which changes the web for existing Community users.
3. `[CRITICAL] (confidence: 8/10) docs/design/mobile-app.md:64` — "Expo is pinned to a release on React 19.1.0" ties the app to Expo SDK 54. By the time Release 1 ships, that is two SDKs old, and Google Play's target-SDK deadline makes it a forced upgrade soon after. With pnpm isolated installs, the app can use the current SDK and its own React, as long as `packages/core` has no React dependency.
4. `[INFORMATIONAL] (confidence: 9/10) services/cloud-api/app/services/signing.py:29` — Sessions last 12 h and there is no refresh token, so phone users would be signed out twice a day. A refresh token is new auth surface:
   - rotation on every use;
   - revocation when a seat is removed or the password changes;
   - stored in the Keystore;
   - covered by tests.
   The plan says "if"; it should be an explicit part of Task 6.3.
5. `[INFORMATIONAL] (confidence: 9/10) services/cloud-api/app/services/oidc.py:79` — OIDC has one configured `redirect_uri`. The app needs a second, allow-listed app-link redirect, plus `/.well-known/assetlinks.json` on the web host. This is additive, but it is not in the plan.
6. `[INFORMATIONAL] (confidence: 8/10) docs/design/mobile-app.md:152` — The Task 6.4 gate needs recorded transcripts from three dongle types. No real dongle is used before the 6.6 field test, so 6.4 can't pass in order. Gate 6.4 on transcripts built from the ELM327 datasheet and the emulator; add real transcripts at 6.6.
7. `[INFORMATIONAL] (confidence: 9/10) services/cloud-api/app/api/v1/jobs.py:464` — The report endpoint returns JSON for a printable page, so "share PDF" means rendering the PDF on the phone (`expo-print` from the same data). The architecture diagram's "reports" box implies the server makes it.
8. `[INFORMATIONAL] (confidence: 9/10) services/cloud-api/app/services/billing.py:24` — The plan lists are hand-synced in six places:
   - `PAID_TIERS`
   - `_TIER_RANK`
   - `TIER_QUOTAS`
   - `TIER_DEFAULT_FEATURES` (`signing.py:38`)
   - web `TIER_LABEL`
   - the proposed `plan-features.ts`

   Adding Mobile touches them all. A parity test catches drift, but one data file read by Python and TypeScript removes it.
9. `[INFORMATIONAL] (confidence: 7/10) services/cloud-api/app/services/billing.py:154` — The free trial is offered to Community only (`trial_tier` is `WORKSHOP`; web `canTrial` checks `tier === "COMMUNITY"`). The plan doesn't say whether a Mobile subscriber can still take the Workshop trial.

Complexity: Phase 6 changes 20+ files [estimated] and adds 3 new units: `packages/core`, `apps/mobile`, and a refresh-token service. The complexity gate applies.

### Scope record

Feature answers: no feature cuts proposed. Structure: B, one shared file (owner answer to D1, 2026-11-27). Accepted scope: Phase 6 as drafted, except the plan table moves into one `packages/schemas/plan_features.json`. `billing.py`, `signing.py`, web and the app all read it. `packages/core` holds only the TypeScript helpers (DTC library, VIN, OBD decoding, formatting); the TS plan catalogue and the parity test are dropped. Finding 8 is resolved by this answer. Pending remedies: findings 1, 2, 3, 4, 9 (R1 to R5 below). Scope Challenge result: scope accepted as-is (smaller arrangement, same scope).

### Corrections recorded (no behaviour change, no question needed)

- Finding 5: Task 6.3 also adds a second, allow-listed OIDC redirect for the app (`oidc.py:79` holds one) and serves `/.well-known/assetlinks.json` from the web host. This is necessary for the SSO sign-in the plan already lists.
- Finding 6: the Task 6.4 gate uses transcripts built from the ELM327 datasheet plus the emulator. Real-dongle transcripts are recorded at 6.6 and added as regression fixtures.
- Finding 7: report PDFs are rendered on the phone (`expo-print`) from `GET /jobs/{id}/report` JSON (`jobs.py:462-464`). The server does not make PDFs.

## Decision ledger

### R1: Send guard is an allow-list
Finding: 1, CRITICAL, 9/10, docs/design/mobile-app.md:94, plan-eng-review
Plan baseline: deny-list. Every request is checked against `safety_policy.json` and gated ones are refused (original proposal, unapproved).
Runtime evidence: `safety_policy.json` lists OBD 0x04/0x08 and the UDS/KWP gated IDs. The ELM327 AT and OBDLink ST command sets are not covered by it. No mobile code exists yet.
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R1 guard type | deny-list (proposal) | allow-list (driver's AT/ST init set + OBD modes 01, 02, 03, 07, 09, 0A), plus deny-list check as a second layer, plus tests | deny-list only |
| R2–R5 | pending | pending | pending |
Question D2:
D2 — Should the phone allow only known-safe commands, or block only known-dangerous ones?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, Release 1 send guard (finding 1, plan line 94).
ELI10: Release 1 must never change anything in the car. The draft blocks the commands on the "dangerous" list in safety_policy.json. But Bluetooth dongles also take their own setup commands, and some (OBDLink) have commands that send raw messages to the car. Those don't look like the listed commands, so a block-list can miss them. An allow-list lets out only the handful of read commands the app actually needs and refuses everything else.
Stakes if we pick wrong: a bug or a tampered app could send a write or clear command through a dongle command the guard never checks, on a customer's car.
Recommendation: A because a read-only release should fail closed (Rule 5), and the allow-list is small and fully testable.
Completeness: A=10/10, B=6/10
Pros / cons:
A) Allow-list (recommended)
  ✅ Nothing leaves the phone unless it is on a short, reviewed list of read commands
  ✅ Raw-transmit dongle commands are refused even if a future change tries to use them
  ❌ Each new read feature must add its command to the list, a small extra step
B) Deny-list only
  ✅ Slightly less code; matches the desktop's policy-file check exactly
  ✅ New read features need no list update
  ❌ Dongle-specific commands that send raw frames are not checked at all
Net: a short list to maintain, in exchange for a guard that cannot be walked around.
Header: Send guard
Options:
A) Allow-list (Recommended)
Only the AT/ST setup commands the driver uses and OBD read modes 01, 02, 03, 07, 09, 0A can leave the phone; everything else is refused before Bluetooth. The safety_policy.json check stays as a second layer. Tests: every gated_set.txt entry, raw-transmit ST/AT commands, unknown commands. (human: ~half day / CC: ~15 min)
B) Deny-list only
Refuse only what safety_policy.json lists. Fewer lines, but dongle commands that send raw frames are not checked.
State: approved
Actual answer: A) Allow-list (owner answer to D2, 2026-11-27)
Accepted scope: Task 6.4's send guard is an allow-list: the driver's AT/ST init set plus OBD modes 01, 02, 03, 07, 09 and 0A. Everything else is refused before Bluetooth, with the `safety_policy.json` deny-list check kept as a second layer. Tests cover every `gated_set.txt` entry, raw-transmit ST/AT commands and unknown commands.
History: none

### R2: Customer report for Community in the app
Finding: 2, CRITICAL, 9/10, docs/design/mobile-app.md:50, plan-eng-review
Plan baseline: matrix locks "Customer report (share PDF from the phone)" for Community (original proposal, unapproved), while saying rows that exist on the web keep the web rule.
Runtime evidence: `jobs.py:463` `def job_report(job_id: str, principal: RequirePrincipal)` has no tier check, so Community gets reports on the web today.
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R2 Community report in app | locked (proposal) | included, same as web | locked in app and web (new server gate) |
| R1 guard | approved: allow-list (D2) | allow-list | allow-list |
| R3–R5 | pending | pending | pending |
Question D3:
D3 — Should free (Community) users be able to share a customer report from the phone?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, plan feature matrix (finding 2, plan line 50).
ELI10: On the website today, free users can already print a customer report. The draft app locks report sharing for free users to make the Mobile plan more attractive. That breaks the plan's own rule that a plan means the same thing on the web and in the app. Locking it everywhere would take something away from today's free users.
Stakes if we pick wrong: free users either lose a feature they have today, or see the same plan behave differently on phone and laptop.
Recommendation: A because it keeps the web unchanged (the owner's requirement) and Mobile still stands out on AI diagnoses (40 vs 5) and live-data recording.
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) Included for Community (recommended)
  ✅ Web and app match; nothing is taken away from existing free users
  ✅ Free users who share reports from the phone become a word-of-mouth funnel
  ❌ One less reason to buy Mobile; it relies on AI quota and recording instead
B) Locked for Community everywhere
  ✅ Clearer reason to upgrade from free to Mobile
  ✅ Web and app still match each other
  ❌ Removes a feature today's free web users already have; needs a new server gate
Net: keep today's free users whole, or make the upgrade pitch stronger.
Header: Free reports
Options:
A) Included (Recommended)
Community can share customer reports from the phone, exactly as they can print them on the web today. Matrix row becomes ✓ for every plan; MOBILE_REPORT_SHARE feature key is dropped. No web or server change.
B) Locked everywhere
Customer reports need Mobile or higher on both web and app. Adds a tier check to GET /jobs/{id}/report and a locked state on the web report page; existing free users lose it.
State: approved
Actual answer: A) Included (owner answer to D3, 2026-11-27)
Accepted scope: Community can share customer reports from the phone, as on the web today. The matrix row is ✓ for every plan, the `MOBILE_REPORT_SHARE` key is dropped, and there is no web or server change.
History: none

### R3: Expo SDK version
Finding: 3, CRITICAL, 8/10, docs/design/mobile-app.md:64, plan-eng-review
Plan baseline: Expo pinned to a release on React 19.1.0 to match web (original proposal, unapproved).
Runtime evidence: `apps/web/package.json` `"react": "19.1.0"`. Web search: Expo SDK 54 uses React 19.1; SDK 56 (May 2026) uses React Native 0.85 and React 19.2. Expo docs: pnpm isolated installs are the default and supported.
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R3 Expo SDK | SDK on React 19.1 (SDK 54) | latest stable SDK at Task 6.3 start, own React; `packages/core` has no React dependency; CI check that web's resolved versions are unchanged | SDK 54 to share React 19.1 with web |
| R1, R2 | approved (D2, D3) | unchanged | unchanged |
| R4, R5 | pending | pending | pending |
Question D4:
D4 — Should the app use the newest Expo version, or an older one that matches the website's React?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, app toolchain (finding 3, plan line 64).
ELI10: Expo is the toolkit the app is built with. The draft picked an older Expo so it uses the same React version as the website. That Expo is already two versions behind, and Google Play keeps raising the Android version apps must target, so it would need a forced upgrade soon after launch. The repo's package manager keeps each app's libraries separate, so the app can use the newest Expo without touching the website.
Stakes if we pick wrong: either a forced, risky upgrade right after launch, or (if done carelessly) the website's libraries change.
Recommendation: A because the separation already exists, and a CI check proves the website's versions don't move.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Newest stable Expo (recommended)
  ✅ Launches on a supported toolkit that meets Google Play's current requirements
  ✅ Website untouched: shared code has no React in it, and CI checks web versions
  ❌ Website and app run different React versions, so shared code must stay plain TypeScript
B) Older Expo matching web React 19.1
  ✅ One React version across the whole repo
  ✅ Shared code could include React pieces later
  ❌ Starts two versions behind; forced upgrade likely within months of launch
Net: two React versions in the repo, in exchange for an app that isn't outdated on day one.
Header: Expo version
Options:
A) Newest stable (Recommended)
Use the latest stable Expo SDK when Task 6.3 starts, with its own React. packages/core stays plain TypeScript (no React). A CI check fails if any version the web app resolves changes.
B) Match web React 19.1
Use Expo SDK 54 so app and web share React 19.1.0. One React version, but the app starts two SDKs behind.
State: approved
Actual answer: A) Newest stable (owner answer to D4, 2026-11-27)
Accepted scope: `apps/mobile` uses the latest stable Expo SDK when Task 6.3 starts, with its own React. `packages/core` stays plain TypeScript with no React dependency. A CI check fails if any version the web app resolves changes.
History: none

### R4: Refresh tokens for phone sign-in
Finding: 4, INFORMATIONAL, 9/10, services/cloud-api/app/services/signing.py:29, plan-eng-review
Plan baseline: "If the API has no refresh token, one is added (additive)" (original proposal, unapproved, conditional).
Runtime evidence: `signing.py:29` `DEFAULT_SESSION_TTL_S = 12 * 3600`; `auth.py` routes include `/login`, `/me`, `/switch-workspace`, no refresh route.
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R4 phone session length | 12 h, then sign in again | refresh token: 30-day sliding, rotated on every use, reuse of an old token revokes the whole family, revoked on seat removal/password change/sign-out; stored in Keystore; web unchanged | no refresh token: phone signs in every 12 h |
| R1–R3 | approved (D2–D4) | unchanged | unchanged |
| R5 | pending | pending | pending |
Question D5:
D5 — Should phone users stay signed in, or sign in again every 12 hours?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, app sign-in (finding 4, signing.py:29).
ELI10: Today a sign-in lasts 12 hours, then you log in again. That's fine on a workshop laptop but annoying on a phone you pull out at the roadside. Staying signed in needs a "refresh token": a long-lived pass stored securely on the phone that quietly gets a new 12-hour sign-in. It's new security code, so it has to be done carefully: replaced every time it's used, and cancelled when a technician is removed or changes their password.
Stakes if we pick wrong: either mechanics get logged out mid-job twice a day, or a stolen phone stays signed in with no way to cut it off.
Recommendation: A because phone apps are expected to stay signed in, and rotation plus revocation keeps a lost phone controllable.
Completeness: A=9/10, B=5/10
Pros / cons:
A) Refresh tokens, done properly (recommended)
  ✅ Mechanics stay signed in for 30 days of use, like every other phone app
  ✅ Removing a technician or changing a password signs that phone out within one refresh
  ❌ New security-sensitive server code and a new table; needs careful tests (human: ~2 days / CC: ~1 h)
B) No refresh tokens
  ✅ No new auth code; the server stays exactly as today
  ✅ A lost phone's sign-in dies on its own within 12 hours
  ❌ Phone users must type their password at least twice a day
Net: a day of careful auth work, in exchange for an app people don't abandon over logins.
Header: Stay signed in
Options:
A) Refresh tokens (Recommended)
Add refresh tokens for the app only: 30-day sliding expiry, rotated on every use, reuse of an old token revokes the whole chain, revoked on seat removal, password change or sign-out, stored in the Android Keystore. Web sign-in unchanged. Tests for each rule.
B) No refresh tokens
Keep today's 12-hour sessions; the app asks for the password again when one expires.
State: approved
Actual answer: A) Refresh tokens (owner answer to D5, 2026-11-27)
Accepted scope: Task 6.3 adds refresh tokens for the app only:
- 30-day sliding expiry, rotated on every use;
- reusing an old token revokes the whole chain;
- revoked on seat removal, password change or sign-out;
- stored in the Android Keystore;
- web sign-in unchanged;
- a test for each rule.
History: none

### R5: Free trial for Mobile subscribers
Finding: 9, INFORMATIONAL, 7/10, services/cloud-api/app/services/billing.py:154, plan-eng-review
Plan baseline: not addressed (original proposal silent).
Runtime evidence: `billing.py:154` `"trial_tier": SubscriptionTier.WORKSHOP.value`, `billing.py:155` `"trial_requires_card": True`. The trial is a Stripe subscription in `trialing` state (`billing.py:407-410`). The web offers it only when `state.tier === "COMMUNITY"` (`apps/web/src/app/(app)/workshop/billing/page.tsx:115`).
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R5 Workshop trial for Mobile subscribers | Community only (existing behaviour) | Community only; Mobile subscribers upgrade directly, prorated by Stripe | Mobile subscribers may take the trial once: their Stripe subscription switches to Workshop in trialing state, then bills Workshop unless they switch back |
| R1–R4 | approved (D2–D5) | unchanged | unchanged |
Question D6:
D6 — Can someone already paying for Mobile take the free 14-day Workshop trial?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, billing rules (finding 9, billing.py:154).
ELI10: Today only free users can start the 14-day Workshop trial, and it needs a card. A Mobile subscriber already has a paid Stripe subscription. Giving them the trial means switching that paid plan into a trial and back, which has fiddly billing cases (part-month refunds, what happens if they forget to switch back). Keeping the trial for free users only means Mobile users who want more just upgrade.
Stakes if we pick wrong: a Mobile customer is charged $99 when they expected $15, or a confusing refund case lands on support.
Recommendation: A because it keeps today's billing rules, and the edge cases of trialing on top of a paid plan aren't worth it for release 1.
Completeness: A=9/10, B=7/10
Pros / cons:
A) Trial stays for free users only (recommended)
  ✅ No change to today's tested trial logic; no surprise charges for Mobile users
  ✅ Mobile users can still upgrade any time; Stripe prorates the difference
  ❌ A Mobile subscriber can't try Workshop features free before paying more
B) Mobile subscribers get the trial once
  ✅ Lets paying phone users try desktop workshop features risk-free
  ✅ Could lift Mobile-to-Workshop upgrades
  ❌ New billing path with surprise-charge and refund cases (human: ~2 days / CC: ~1 h plus tests)
Net: simpler billing now, or a softer upgrade path with more ways for billing to go wrong.
Header: Mobile trial
Options:
A) Free users only (Recommended)
Keep today's rule: the Workshop trial is offered to Community only. Mobile subscribers upgrade directly with Stripe proration. Add a test that a Mobile tenant is not offered the trial.
B) Mobile once too
Mobile subscribers may take the 14-day Workshop trial once; their Stripe subscription moves to Workshop trialing and bills Workshop afterwards unless they switch back. New tests for the switch, the reminder email and switching back.
State: approved
Actual answer: A) Free users only (owner answer to D6, 2026-11-27)
Accepted scope: the Workshop trial stays Community-only. Mobile subscribers upgrade directly, with Stripe proration. Task 6.1 adds a test that a Mobile tenant is not offered the trial.
History: none

Approval checkpoint after Scope Challenge: R1–R5 approved (D2–D6).

### Section 1: Architecture review

Two shapes (design-twice), for the new `packages/core` boundary:
- Shape A (chosen): `packages/core` holds the plain-TypeScript helpers (DTC library, VIN, OBD-II PID decode, formatting). Web and mobile both import it, and plan data comes from `packages/schemas/plan_features.json` (D1).
- Shape B: the helpers stay in `apps/web/src/lib`, and mobile keeps its own copies. Rejected: it creates two ways to decode a PID (red flag 6), and the copies drift.
- Depth: A hides PID scaling, DTC text lookup and VIN masking behind a few pure functions (`decodePid`, `describeDtc`, `redactVin`), with no React or I/O in its interface.

Red flags screened:
- 2, information leakage: resolved by D1.
- 6, two ways: see R7.
- 7, importable internals: `apps/mobile` could import `apps/web/src/lib/*` by relative path. Fix (required by the owner's isolation rule, no question): an ESLint `no-restricted-imports` rule plus a CI grep fail the build on any `apps/web` import from `apps/mobile` and on any `apps/mobile` import from `apps/web`.
- 8, hand-synced list: resolved by D1.
- 1, 3, 4, 5: none found.

Findings:
1. `[CRITICAL] (confidence: 8/10) docs/design/mobile-app.md:96` — When Bluetooth drops mid-scan (phone locks, dongle unplugged, car's ignition off), the draft has no rule for what the screen shows. If a partial read is shown as "0 codes", a car with faults looks healthy. `docs/PLAN.md` Rule 6 ("never reports a pass") already sets the contract, so this is required work with no question. Any mode 03/07/0A read that times out, disconnects or returns `NO DATA` / `CAN ERROR` / `BUS INIT…ERROR` is shown as "Scan incomplete". It is never shown as "No codes", and it is stored on the job as incomplete. Tests cover each response.
2. `[INFORMATIONAL] (confidence: 8/10) docs/design/mobile-app.md:46` — Live-data recording on a road test means the phone is in a pocket or mount with the screen off. Android stops a backgrounded app's Bluetooth, so the recording silently stops. See R6.
3. `[INFORMATIONAL] (confidence: 7/10) docs/design/mobile-app.md:62` — Re-export shims leave two import paths for the same helpers in web. See R7.

Production failure per new path:
- Bluetooth drop: finding 1.
- Expired session offline: the refresh token (R4) retries when back online, and the scan queue keeps results.
- Mobile checkout with no Stripe price configured: the existing checkout path returns an error for a missing price setting. Task 6.1 adds a test that Mobile checkout without `stripe_price_mobile_month` is refused clearly, not with a 500.

Distribution: CI builds the debug APK (6.3) and the signed AAB on tags (6.6). Play internal testing is the update channel. Rugged tablets are Phase 8.

### R6: Recording with the screen off
Finding: Section 1 finding 2, INFORMATIONAL, 8/10, docs/design/mobile-app.md:46, plan-eng-review
Plan baseline: "Live data recording and CSV export" for Mobile and up, with no background rule (original proposal, unapproved).
Runtime evidence: no mobile code yet. Android stops background Bluetooth work for apps without a foreground service; Android 14 requires a declared foreground-service type (`connectedDevice`).
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R6 recording when screen off | unspecified | foreground service (`connectedDevice`) with an ongoing "Recording live data" notification and a Stop button; written to disk in 1-minute chunks; capped at 4 h per recording | recording only while the app is open; screen kept awake; stops (and says so) if the app goes to background |
| R1–R5 | approved | unchanged | unchanged |
| R7 | pending | pending | pending |
Question D7:
D7 — Should live-data recording keep going when the phone screen is off?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, live-data recording (Section 1 finding 2).
ELI10: A mobile mechanic records live data on a road test with the phone in a mount or pocket. Android stops Bluetooth for apps in the background unless they show an ongoing notification ("Recording live data", with a Stop button). Without that, the recording silently ends when the screen turns off.
Stakes if we pick wrong: a mechanic does a 20-minute road test and gets a 30-second recording.
Recommendation: A because road tests are the main reason to record on a phone, and the notification keeps the user in control.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Keeps recording with a notification (recommended)
  ✅ Road tests record fully with the screen off or the app in the background
  ✅ Ongoing notification with a Stop button; disk chunks and a 4-hour cap keep storage bounded
  ❌ Extra Android setup and a Play declaration for the foreground service (human: ~1 day / CC: ~30 min)
B) Only while the app is open
  ✅ Simplest; no foreground service or Play declaration
  ✅ The screen stays on, so the user sees the graph the whole time
  ❌ Recording stops when the screen locks or another app opens; the battery drains with the screen on
Net: a day of Android plumbing, in exchange for recordings that survive a real road test.
Header: Screen-off rec
Options:
A) Keep recording (Recommended)
Recording runs as an Android foreground service (connectedDevice) with an ongoing "Recording live data" notification and a Stop button; data written to disk in 1-minute chunks; each recording capped at 4 hours. Tests for start, stop, Bluetooth drop and the cap.
B) App open only
Recording works only while the app is open; the screen is kept awake, and if the app goes to the background the recording stops and the app says so on return.
State: approved
Actual answer: A) Keep recording (owner answer to D7, 2026-11-27)
Accepted scope: recording runs as an Android foreground service (`connectedDevice`) with an ongoing "Recording live data" notification and a Stop button. Data is written to disk in 1-minute chunks, and each recording is capped at 4 hours. Tests cover start, stop, a Bluetooth drop and the cap.
History: none

### R7: Web imports after the helpers move to packages/core
Finding: Section 1 finding 3, INFORMATIONAL, 7/10, docs/design/mobile-app.md:62, plan-eng-review
Plan baseline: "The old paths stay as one-line re-exports, so no web import changes" (original proposal, unapproved).
Runtime evidence: the helpers live in `apps/web/src/lib/` (`dtc-library.ts`, `vin.ts`, `format.ts`, `diag.ts`); web pages import them via `@/lib/...`.
Comparison grid:
| Choice | Current | A | B |
| --- | --- | --- | --- |
| R7 web import path | `@/lib/<helper>` | web imports switch to `@rootcause/core` in the same PR; old files deleted; web unit + build + full Playwright must pass unchanged | old files stay as re-export shims; web imports untouched; lint rule bans the shim paths in new code |
| R1–R6 | approved | unchanged | unchanged |
Question D8:
D8 — When the shared helpers move out of the website, should the website's imports move too?
Project/branch/task: RootCause mobile plan review on claude/fervent-goldberg-j9n8fk, packages/core extraction (Section 1 finding 3).
ELI10: Some website code (fault-code text, VIN masking, live-data maths) moves to a shared folder so the app can use it. The draft leaves "forwarding" files in the website so no website file changes. But then there are two ways to import the same thing, and the next person (or AI) copies whichever they see first. Moving the imports is a mechanical change, and the full website test suite proves nothing broke.
Stakes if we pick wrong: either a slightly bigger website diff now, or two import paths that slowly drift apart.
Recommendation: A because one import path can't drift, and the website's unit and browser tests prove behaviour is unchanged.
Completeness: A=9/10, B=8/10
Pros / cons:
A) Move the imports (recommended)
  ✅ One way to import each helper; nothing left to drift or clean up later
  ✅ Website behaviour is proven by the same unit, build and Playwright tests as today
  ❌ More website files appear in the diff (import lines only) (human: ~2h / CC: ~10 min)
B) Keep forwarding files
  ✅ Website files are not touched at all; smallest possible website diff
  ✅ A lint rule stops new code from using the old paths
  ❌ Two import paths remain until someone removes the forwarding files
Net: a few dozen import-line changes now, or a permanent second path.
Header: Web imports
Options:
A) Move imports (Recommended)
In the same PR, web imports switch to @rootcause/core and the old helper files are deleted. Web unit tests, next build and the full Playwright suite must pass unchanged.
B) Forwarding files
Old helper files stay as one-line re-exports so no web import changes; a lint rule bans those paths in new code.
State: approved
Actual answer: A) Move imports (owner answer to D8, 2026-11-27)
Accepted scope: in the same PR, web imports switch to `@rootcause/core` and the old helper files are deleted. Web unit tests, `next build` and the full Playwright suite must pass unchanged.
History: none

Approval checkpoint after Section 1: R6, R7 approved (D7, D8). Dispositions: Section 1 finding 1 accepted as required work (Rule 6); finding 2 → R6 approved (A); finding 3 → R7 approved (A); red flag 7 fix accepted as required work (owner isolation rule).

### Section 2: Code quality review

Shared-code rubric for `packages/core`:
- Verified callers (existing): `apps/web/src/lib/dtc-library.ts`, `vin.ts` (`redactVin`, used by `lib/ident.ts` and `key-programming/page.tsx`), `format.ts`, `diag.ts`.
- Proposed caller: `apps/mobile` (Task 6.5, labelled proposal).
- Reuse before extract: no existing package holds these, since `packages/schemas` is data plus generated types. The helpers are moved, not rewritten.
- Size [estimated]:
  - implementation: removed ~400–600 lines from `apps/web/src/lib`, added the same ~400–600 in `packages/core`, net ≈ 0;
  - integration: ~30–60 import lines changed in web;
  - tests: `apps/web/tests/diag.test.ts` and related tests move with the code, net ≈ 0;
  - net growth: one `package.json` and `tsconfig`.
  - The gain is reliability (one decoder for both apps), not lines.
- Blast radius: a decode bug now hits web and app at once. The moved tests and web Playwright guard it.

Findings:
1. `[INFORMATIONAL] (confidence: 8/10) docs/design/mobile-app.md:94` — Engine-code reads over CAN get one reply per ECU (`7E8` engine, `7E9` transmission and so on). The draft's driver line covers single replies only. Required for the approved read features, no question: mode 03/07/0A replies are parsed per ECU header (`ATH1` is already in the init), merged, and each code is labelled with its module. Tests cover two-ECU, multi-frame (ISO-TP first/consecutive frame) and zero-code replies.
2. `[INFORMATIONAL] (confidence: 7/10) docs/design/mobile-app.md:93` — ELM clones answer `?` to unsupported AT commands, and some echo even after `ATE0`. Required: the driver treats `?` on an optional AT command as "not supported" and continues. On a required one it stops with a clear "This dongle isn't supported" message. Echo lines are stripped by matching the sent command. Tests come from the datasheet-derived transcripts (correction for finding 6).
3. `[INFORMATIONAL] (confidence: 5/10) services/cloud-api/app/api/v1/sessions.py:176` — Medium confidence, verify this is actually an issue. `POST /sessions/sync` (`SyncBatchRequest`: `batch_id`, `session_id`, `telemetry_rows`) looks reusable for phone telemetry and is idempotent on `batch_id`, which suits the offline queue. But it was built for the edge daemon, and its session creation path may assume a daemon. Task 6.5 checks this first. If it assumes a daemon, the phone gets a session-creation route; the sync route stays shared.

Dispositions: 1 and 2 accepted as required work for approved features; 3 accepted as a verification step in 6.5. No new choices.

### Section 3: Test review

Framework (auto-detected): pytest (`services/cloud-api/tests`), Vitest (`apps/web/tests`), Playwright (`apps/web/e2e`), cargo test. Proposed for `apps/mobile`: Jest with `jest-expo` (Expo's default), plus Maestro for one emulator flow. Both are named in the plan's Task 6.3/6.5 gates, which the owner approved with D4 (React Native / Expo).

Regression contract (carried forward, not re-asked):
- D1: "billing.py is reworked to load its table from it; existing billing tests must stay green". Required proof: a golden test that the four existing tiers load from `plan_features.json` with today's exact prices, quotas, seats, sites and features.
- D8: "Web unit tests, next build and the full Playwright suite must pass unchanged".

```
CODE PATHS                                                   USER FLOWS
[+] services/cloud-api billing + signing (D1 rework)         [+] Buy Mobile on the web
  ├── load plan_features.json                                  ├── [GAP] [→E2E] Billing page shows Mobile card, checkout starts
  │   ├── [★★ TESTED] 4 existing tiers — tests/test_billing.py ├── [GAP] Webhook sets tier MOBILE, /auth/me shows 40 AI
  │   ├── [GAP] golden: 4 tiers byte-for-byte unchanged         └── [GAP] Mobile → Pro upgrade; Pro → Mobile downgrade bumps lease_version
  │   ├── [GAP] MOBILE row: price, quota, features []
  │   └── [GAP] file missing/invalid → API refuses to start
  ├── MOBILE enum migration (ALTER TYPE ADD VALUE)             [+] Sign in on the phone
  │   └── [GAP] upgrade + downgrade on a migrated dev DB          ├── [GAP] Password sign-in → plan screen
  ├── trial offer: Community only (D6)                         ├── [GAP] SSO via app link → back in app
  │   └── [GAP] Mobile tenant not offered trial                ├── [GAP] Refresh after 12 h; reuse of old token → signed out
  ├── checkout without stripe_price_mobile_month               └── [GAP] Seat removed → next refresh fails → sign-in screen
  │   └── [GAP] clear refusal, not 500
  └── refresh tokens (D5)                                      [+] Scan a car (fake transport + ELM emulator)
      ├── [GAP] rotate on use                                  ├── [GAP] [→E2E Maestro] Connect → scan → codes per ECU → job saved
      ├── [GAP] reuse of old token revokes chain               ├── [GAP] Bluetooth drop mid-scan → "Scan incomplete", never "No codes"
      ├── [GAP] revoked on seat removal / password change      ├── [GAP] Offline scan → queued → synced once (same batch_id)
      ├── [GAP] 30-day sliding expiry boundary                 └── [GAP] Community: recording locked with "Mobile and up"
      └── [GAP] web sessions unchanged (12 h, no refresh)
                                                               [+] Record live data (D7)
[+] packages/core (moved, D8)                                  ├── [GAP] Screen off → keeps recording (foreground service)
  ├── [★★ TESTED] diag/dtc/vin — apps/web/tests/*.test.ts      ├── [GAP] 4 h cap stops cleanly; chunks readable after crash
  └── [GAP] no apps/web ↔ apps/mobile imports (lint + CI grep) └── [GAP] Disk full → clear error, recording kept so far

[+] apps/mobile OBD service                                    [+] Plan matrix
  ├── send guard (D2 allow-list)                               └── [GAP] For each of 5 plans × every feature:
  │   ├── [GAP] every gated_set.txt entry refused                  available / locked / desktop-only matches plan_features.json
  │   ├── [GAP] OBD 04 and 08 refused
  │   ├── [GAP] ST/AT raw-transmit commands refused            [+] Web unchanged (D8 regression contract)
  │   └── [GAP] unknown command refused                        └── [★★★ TESTED] existing Vitest + next build + Playwright
  ├── ELM327 driver
  │   ├── [GAP] init on clone (`?`, echo after ATE0)           LLM integration: AI diagnosis reuses the existing
  │   ├── [GAP] NO DATA / CAN ERROR / BUS INIT ERROR / STOPPED   /diagnose endpoint unchanged → no new eval
  │   └── [GAP] multi-ECU + ISO-TP multi-frame replies
  └── transports (BLE, classic) — [GAP] connect/disconnect via fake transport

COVERAGE: 4/43 paths tested (9%) | Code paths: 3/27 | User flows: 1/16
QUALITY: ★★★:1 ★★:3 ★:0 | GAPS: 39 (2 E2E: web checkout Playwright, phone scan Maestro; 0 eval)
```

All 39 gaps are new code that the approved tasks already require tests for (the Verification Gates plus D1–D8). No new test policy needs an answer.

Test plan artifact: written to the gstack project directory (see Completion summary).

Tests made obsolete: none. `apps/web/tests/diag.test.ts` and related tests move to `packages/core` unchanged.

Dispositions: all gaps accepted as required proof of approved behaviour; regression contract carried from D1 and D8.

### Section 4: Performance review

1. `[INFORMATIONAL] (confidence: 7/10) docs/design/mobile-app.md:94` — An ELM327 over Bluetooth manages about 10–20 requests a second [estimated, typical clone]. Polling one PID per request gives a choppy graph with 6+ PIDs. Required for usable live data: on CAN, mode 01 requests batch up to 6 PIDs each (allowed by SAE J1979 on CAN). The graph refreshes at whatever rate the dongle sustains, and the measured rate is shown. Scale: 6 PIDs at ~3–5 Hz each [estimated].
2. `[INFORMATIONAL] (confidence: 7/10) services/cloud-api/app/api/v1/sessions.py:181` — Uploading a 4-hour recording in one request would be several MB [estimated: 6 PIDs × 4 Hz × 14,400 s ≈ 350k rows]. Required: upload in batches with a fixed row cap (same pattern as `can_traces.MAX_FRAMES_PER_BATCH`), one `batch_id` per chunk, resumable after a drop.
3. `[INFORMATIONAL] (confidence: 6/10) docs/design/mobile-app.md:99` — The offline queue and recordings live on the phone with no total limit (each recording is capped at 4 h by D7). Required: the app shows storage used in Settings, and a full disk gives a clear error instead of a silent failure. No automatic deletion.

Dispositions: all three accepted as required implementation of approved features; no new choices.

### Outside voice

Outside voice unavailable: the Codex CLI is not installed (`which codex` found nothing). The native Claude subagent fallback was not dispatched, because this session's rules allow subagents only when the owner asks. Fix: install and log in to the Codex CLI, or ask for a subagent review. Continuing to planning decisions and Approval readiness. (OUTSIDE_VOICE_UNAVAILABLE)

### TODOS

No `TODOS.md` in the repo, and no review finding was deferred, so no TODO items are proposed. Phases 7 and 8 are already sequenced in `docs/PLAN.md` placement (section 6).

Approval readiness: PASS. Checked: D1 structure (scope record); R1/D2, R2/D3, R3/D4, R4/D5, R5/D6, R6/D7, R7/D8, all approved. Required-work items cite PLAN.md Rule 6 (Section 1 finding 1), the owner's isolation rule (red flag 7), and approved features (Sections 2 to 4). Regression contract carried from D1 and D8.

### NOT in scope (Phase 6)

- Clearing codes and service functions on the phone: release 2 (Phase 7), with the Rust interlock (owner D2).
- iOS: Phase 8.3 (owner D3).
- Selling plans inside the app (Google Play Billing): open decision 3; release 1 only signs in and shows the plan.
- Rugged dedicated-device provisioning and the Linux kiosk image: Phase 8.1 and 8.2.
- Manufacturer (enhanced) module scans over ELM327: release 1 reads generic OBD-II only.
- Workshop trial for Mobile subscribers: declined (D6).
- Removing the old `apps/android` prototype: open decision 5.

### What already exists (reused, not rebuilt)

- Sign-in: `/auth/login`, `/auth/me`, OIDC with PKCE (`auth.py:287-326`), reused. New: app redirect (correction for finding 5) and refresh tokens (D5).
- Jobs, AI diagnosis, report data: `jobs.py`, `diagnose.py`, `GET /jobs/{id}/report`, reused unchanged.
- Telemetry upload: `POST /sessions/sync` (idempotent `batch_id`), reused if Task 6.5's check passes (Section 2 finding 3).
- Plan rules: `billing.py` / `signing.py`, now loaded from one `plan_features.json` (D1).
- Safety policy: `packages/schemas/safety_policy.json` and `fixtures/gated_set.txt`, reused as the guard's second layer and test input (D2).
- Helpers: `dtc-library.ts`, `vin.ts` (`redactVin`), `format.ts`, `diag.ts`, moved to `packages/core` (D8).

### Failure modes

| New path | Realistic failure | Test | Handling | User sees |
| --- | --- | --- | --- | --- |
| Bluetooth scan | dongle unplugged mid-read | yes (Section 3) | marked incomplete (Rule 6) | "Scan incomplete" |
| Send guard | new code sends an unlisted command | yes | refused before Bluetooth | error, nothing sent |
| Refresh token | stolen phone after seat removal | yes | revoked at next refresh | sign-in screen |
| Recording | screen off on road test | yes | foreground service (D7) | ongoing notification |
| Recording upload | signal drops mid-upload | yes | chunked, resumable `batch_id` | "Syncing…" then done |
| Plan file | `plan_features.json` invalid after an edit | yes | API refuses to start; CI schema check | deploy blocked, not customers |
| Mobile checkout | Stripe price not set | yes | clear refusal | "Mobile plan isn't available yet" |
| Enum migration | downgrade from MOBILE on old code | yes (migrated dev DB) | migration ships before code that writes MOBILE | none |

Critical gaps (no test, no handling, silent): 0.

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| 6.1 Mobile plan + plan_features.json | services/cloud-api, packages/schemas, apps/web (billing page) | — |
| 6.2 packages/core | packages/core, apps/web (imports) | — |
| Refresh tokens + OIDC app redirect | services/cloud-api (auth) | 6.1 (shared billing/auth tests, migrations) |
| 6.3 App shell | apps/mobile, .github/workflows | 6.2 |
| 6.4 Bluetooth + ELM327 | apps/mobile (obd/) | 6.3 |
| 6.5 Read features | apps/mobile, services/cloud-api (sessions check) | 6.1, 6.4, refresh tokens |
| 6.6 Release | apps/mobile, .github/workflows | 6.5 |

- Parallel lanes:
  - Lane A: 6.1 → refresh tokens (services/cloud-api, shared).
  - Lane B: 6.2 → 6.3 → 6.4 (packages/core, apps/mobile).
- Execution order: launch A and B. Merge both. Then 6.5, then 6.6.
- Conflict flags: `apps/web` is touched by 6.1 (billing page) and 6.2 (imports), so merge 6.2 first or rebase. `pnpm-lock.yaml` is touched by 6.2 and 6.3 (same lane).
- `docs/PLAN.md` Rule 1 runs tasks one at a time. If Rule 1 isn't changed, run these in order: 6.1, 6.2, refresh tokens, 6.3, 6.4, 6.5, 6.6.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship. Effort assumes features ~30x, tests ~50x, scaffolding ~100x human÷CC.

- [ ] **T1 (P1, human: ~1.5d / CC: ~45min)** — cloud-api + schemas — Move the plan table into `plan_features.json` and add the Mobile tier
  - Surfaced by: Scope record (D1), findings 8 and 9 (D6), Section 1 production-failure note
  - Files: `packages/schemas/plan_features.json` (+ schema), `services/cloud-api/app/services/billing.py`, `signing.py`, `app/db/models.py`, `migrations/versions/<new>.py`, `app/config.py`, `apps/web/src/lib/entitlements.ts`, `apps/web/src/app/(app)/workshop/billing/page.tsx`
  - Verify: `just test`. Golden test of the 4 existing tiers. Mobile checkout, webhook, upgrade/downgrade, no-trial and missing-price tests. Existing Playwright unchanged.
- [ ] **T2 (P1, human: ~1d / CC: ~20min)** — packages/core — Move the helpers and switch web imports
  - Surfaced by: R7 (D8), Section 2 rubric, red flag 7
  - Files: `packages/core/**`, `apps/web/src/lib/{dtc-library,vin,format,diag}.ts` (deleted), web import sites, `pnpm-workspace.yaml`, ESLint config
  - Verify: web Vitest, `next build` and the full Playwright suite green. The web resolved-versions check and the no-cross-import CI grep pass.
- [ ] **T3 (P1, human: ~2d / CC: ~1h)** — cloud-api auth — Add app-only refresh tokens and the OIDC app redirect
  - Surfaced by: finding 4 (D5), finding 5 (correction)
  - Files: `services/cloud-api/app/api/v1/auth.py`, `app/services/signing.py`, `app/services/oidc.py`, a new migration, `apps/web/public/.well-known/assetlinks.json`
  - Verify: pytest for rotation, reuse revoking the chain, seat-removal and password-change revocation, the 30-day boundary, and web sessions unchanged
- [ ] **T4 (P1, human: ~3d / CC: ~1h)** — apps/mobile — Build the Expo app shell (latest stable SDK, Android)
  - Surfaced by: R3 (D4), Task 6.3
  - Files: `apps/mobile/**`, `.github/workflows/ci.yml`
  - Verify: CI builds the debug APK artifact. Jest, lint and typecheck pass.
- [ ] **T5 (P1, human: ~4d / CC: ~1.5h)** — apps/mobile obd — Build the transports, ELM327 driver and allow-list send guard
  - Surfaced by: R1 (D2), Section 2 findings 1 and 2, finding 6 (correction), Section 4 finding 1
  - Files: `apps/mobile/src/obd/**`, datasheet-derived transcript fixtures
  - Verify: Jest. The guard refuses every `gated_set.txt` entry, OBD 04/08, ST/AT raw transmit and unknown commands. Driver tests cover clone quirks, NO DATA/CAN ERROR/BUS INIT ERROR, multi-ECU and ISO-TP.
- [ ] **T6 (P1, human: ~5d / CC: ~2h)** — apps/mobile — Build the read features, recording service, sync and plan matrix
  - Surfaced by: Section 1 finding 1 (Rule 6), R2 (D3), R6 (D7), Section 2 finding 3, Section 4 findings 2 and 3, finding 7 (correction)
  - Files: `apps/mobile/src/**`, possibly `services/cloud-api/app/api/v1/sessions.py`
  - Verify: Jest. "Scan incomplete" cases, the 5×N plan matrix test, recording cap and disk-full tests, chunked resumable upload, and a Maestro emulator flow in CI.
- [ ] **T7 (P2, human: ~1d / CC: ~30min)** — release — Play App Signing, internal track, Data safety form, foreground-service declaration
  - Surfaced by: Task 6.6, R6 (D7) Play declaration
  - Files: `.github/workflows/package.yml` (or a new mobile release workflow), `apps/mobile/app.config.*`
  - Verify: signed AAB on a tag. Owner field checklist on a real phone and dongle; transcripts saved as fixtures.

### Unresolved decisions

None in this review. The plan's own "Open decisions for the owner" (section 7) stay open for the owner and are not review findings:
1. Mobile plan numbers.
2. Community in the app.
3. In-app selling.
4. Rule 1 placement.
5. The old Kotlin prototype.

### Completion summary
- Step 0: Scope Challenge — scope accepted as-is (smaller arrangement, D1)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY: phase=eng rows=7/7 missing=none verdict=complete`), 0 unverified premises
- Architecture Review: 3 issues found
- Code Quality Review: 3 issues found
- Test Review: diagram produced, 39 gaps identified
- Performance Review: 3 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, unavailable (CLI not installed; native subagent not dispatched under session rules)
- Parallelization: 2 lanes, 2 parallel / 7 sequential steps
- Lake Score: 1/6 (answers picking a 10/10 option out of those scored: D2 10, D4 9, D5 9, D6 9, D7 9, D8 9; D3 had no score)

### Suppressed findings (appendix)

None below confidence 5.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review` outside voice | Independent 2nd opinion | 1 | unavailable | Codex CLI not installed; native subagent not dispatched under session rules |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 48 issues (mapped to approved tasks T1–T7), 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase, unavailable (CLI not installed); no outside findings.
- **VERDICT:** no review CLEAR yet. Every finding is resolved by an owner answer (D1–D8) or required work mapped to T1–T7; status stays ISSUES OPEN until the work ships. eng review required.

NO UNRESOLVED DECISIONS
