# RootCause Mobile (Android)

The phone app **is the RootCause web app**: its main screen shows the website in a
web view, so it has exactly the same pages, navigation, colours and plan gates as
the web. They're the same code reading the same `/auth/me` entitlements and daemon
lease, so a feature locked on the web is locked here, with the same upgrade prompts.
On top of that the app adds:

- **Sign-in with Google or AWS Cognito** in the phone's browser, because Google refuses
  embedded web views. The app sends a PKCE challenge to `/oidc/start` and redeems the
  hand-off from `rootcause://auth/callback` with its verifier (`src/auth/sso.ts`; the
  API side is migration 015). Password sign-in is the web's own form.
- **The phone's own Bluetooth dongle, read-only.** Go to Devices, then **Use a dongle
  with this phone**. It reads codes, readiness, VIN, freeze frame and live data, and
  every command passes the send guard allow-list (`src/obd/sendGuard.ts`).
- **No purchases in the app.** Stripe Checkout and the billing portal never load
  (`src/web/policy.ts`). The billing page shows plans and what they include, and tells
  the owner to change plans on the website (Google Play rules).

**Changing a car** (clearing codes, service functions, key programming) works
only through the edge daemon and its safety interlock: checklist, hold-to-confirm and
audit log, exactly as on the web. The phone never sends these over Bluetooth.
Instead it **pairs with the workshop PC**: on the PC, Devices → Phone access →
*Pair a phone* shows a QR code; on the phone, Devices → *Pair with a PC* scans it.
The app then reaches that PC's daemon over the workshop Wi-Fi with TLS, pinned to
the certificate in the QR code (`modules/daemon-link`, `src/lan`). Phone access is
off on a PC until an administrator runs `edge-daemon lan enable`. Until a PC is
paired, the app says so and those actions stay locked. Design and threat model:
`docs/design/lan-phone-access.md`.

## Addresses

| Build | Web app | API |
| --- | --- | --- |
| Release | `EXPO_PUBLIC_APP_URL` (https) | `EXPO_PUBLIC_API_URL` (https) |
| Dev | `http://127.0.0.1:3000` | `http://127.0.0.1:8000` |

A release build without https addresses shows "This build isn't set up" instead of
loading. For a dev build, `adb reverse tcp:3000 tcp:3000`, `adb reverse tcp:8000
tcp:8000` and (for the daemon) `adb reverse tcp:8765 tcp:8765`. A dev build with no
PC paired uses that loopback daemon; once paired it uses the PC.

## What each plan unlocks

The web app decides, from the API. The phone dongle screens use
`packages/schemas/plan_features.json`, the same file the server and website read.
The Mobile plan in that file is switched off on the server (`PLAN_MOBILE_ENABLED`)
until it's approved.

## Develop

```bash
pnpm install
cd apps/mobile
pnpm test        # web view policy, bridge, SSO hand-off, tokens, OBD driver, send guard, plans, PC pairing
pnpm typecheck
npx expo run:android   # needs the Android SDK and a phone or emulator
```

## How it's built

- `app/index.tsx`: the web view, the bridge and the Android back button.
- `src/web/policy.ts`: what may load (RootCause origin only; Stripe never; other sites
  open in the browser; `intent:`, `file:` and `javascript:` refused).
- `src/web/bridge.ts`: messages from the web (`apps/web/src/lib/native.ts`), accepted
  only from the RootCause origin and only in known shapes.
- `src/auth/sso.ts`: provider sign-in through the system browser.
- `src/ui/tokens.ts`: the web's design tokens for the app's own screens
  (`tests/tokens.test.ts` keeps them equal to `globals.css`).
- `app/dongle/*`, `src/obd/*`, `src/transports/*`: the read-only phone dongle.
- `app/lan/pair.tsx`, `src/lan/*`, `modules/daemon-link`: pairing with the workshop
  PC (camera or pasted link), the paired PC in secure storage, and the relay that
  carries the web app's daemon connection over the pinned TLS link (Kotlin, OkHttp).
