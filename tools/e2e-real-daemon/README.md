# Real-daemon browser E2E

Drives the web app in a headless browser against a **locally running** stack:
cloud API (`:8000`, with `AUTH_ALLOW_DEV_LOGIN=true`), web app (`:3000`) and a
debug build of the edge daemon (`:8765`) with its virtual vehicles. Nothing is
mocked: scans, clears and service functions go through the daemon's safety
interlock.

```bash
cd tools/e2e-real-daemon
npm install          # or: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install, then set E2E_CHROME
node p0-community.mjs   # sign up → devices → new job (VIN read) → scan → AI → live data → close-out → report
node p1-workshop.mjs    # dev plan grant → lease sync → Active mode → clear codes (hold) → oil reset → CAN Studio
node p2-team.mjs        # seat cap on Community → Fleet → add site → invite → invitee joins (mobile) → single-use link
```

Screenshots go to `./shots` (override with `E2E_SHOTS`). `E2E_WEB`, `E2E_API`
and `E2E_CHROME` override the defaults. The Workshop run uses the dev-only
`/api/v1/auth/dev-grant-plan` endpoint, so it only works against a local API.
