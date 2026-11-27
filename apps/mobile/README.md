# RootCause Mobile (Android)

The phone app for diagnosing with a Bluetooth OBD-II dongle. Release 1 is
**read-only**: it reads codes, readiness, VIN, freeze frame and live data, and
never changes anything in the car. Clearing codes and service functions stay on
the desktop app, which runs the safety checks. Plan: `docs/design/mobile-app.md`.

## What each plan unlocks

Every feature comes from `packages/schemas/plan_features.json`, the same file the
server and the website read. The app's **Your plan** screen shows the list for the
signed-in workshop.

## Try it on a phone

1. Open the latest **mobile** run in GitHub Actions and download
   `rootcause-mobile-debug-apk`.
2. Copy the `.apk` to an Android phone (Android 8 or newer) and open it. Android
   asks to allow installs from that source.
3. Sign in with your RootCause email and password.
4. **Connect a dongle**: pair a classic ELM327 in Android's Bluetooth settings
   first (PIN 1234 or 0000), or tap **Search** for a Bluetooth LE dongle. With no
   dongle, **Use the demo car** runs everything on a simulated car.

The debug APK talks to the API at `EXPO_PUBLIC_API_URL` (set at build time); on the
Android emulator the default reaches a local server at `http://10.0.2.2:8000`.

## Develop

```bash
pnpm install
cd apps/mobile
pnpm test        # OBD driver, send guard, plan matrix, report (Node, no phone)
pnpm typecheck
npx expo run:android   # needs the Android SDK and a phone or emulator
```

## How it's built

- `src/obd/sendGuard.ts`: the allow-list every command passes through.
- `src/obd/elm327.ts`, `frames.ts`, `scan.ts`: dongle driver, reply parsing per
  module, and the reads. A failed read shows as "Scan incomplete", never "no codes".
- `src/obd/emulator.ts`: the simulated dongle and car used by tests and demo mode.
- `src/transports/`: Bluetooth LE (`react-native-ble-plx`) and classic Bluetooth
  (`modules/bt-classic`, a small Kotlin module in this app).
- `src/plan/access.ts`: available / locked / desktop-only per feature.
