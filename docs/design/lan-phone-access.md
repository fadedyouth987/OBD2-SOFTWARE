# Phone access to the edge daemon over the workshop network

The Android app shows the web app, so it has the same Devices, job and
service pages. Until now it couldn't reach the edge daemon, which listens only
on the workshop PC's loopback. On a phone that meant "daemon offline", and
clearing codes, service functions and key programming stayed locked. This
design lets a technician pair their phone with the workshop PC once. After that
the phone's car changes run on that PC's daemon, through the same safety
interlock, hold-to-confirm and audit log as the PC's own browser.

The Mobile plan stays off (`PLAN_MOBILE_ENABLED`). Phone access doesn't change
what any plan includes. The daemon still applies the technician's own lease.

## How a technician pairs a phone

1. **Turn phone access on, once per PC.** As an administrator on the PC:

   ```
   edge-daemon lan enable            # add --mdns to advertise on the network
   ```

   Then restart the service and allow the port (TCP 8766 by default) on the
   PC's firewall, for the private (workshop) network profile only. The command
   prints the exact lines for Windows and Linux. `edge-daemon lan status` shows
   the state, and `edge-daemon lan disable` turns it off again.
2. **On the PC**, open RootCause → Devices → *Phone access* and choose
   **Pair a phone**. A QR code appears. It works once, for 5 minutes. If the PC
   has more than one address, choose the one the phone's Wi-Fi can reach.
   Without a browser, `edge-daemon lan pair` prints the same code in the
   terminal.
3. **On the phone**, open Devices → *Workshop PC* → **Pair with a PC** and scan
   the code. The app shows the PC's name, address and the start of its
   certificate fingerprint (the PC's screen shows the same start). Then tap
   **Pair**. If the camera can't read the code, use *Can't scan? Show the
   pairing link* on the PC and paste the link into the app.
4. The phone now reconnects by itself whenever it's on the workshop Wi-Fi. The
   PC's *Phone access* list shows each phone, whether it's connected, and when
   it was last seen. **Remove** disconnects that phone immediately, and it has
   to pair again to come back. `edge-daemon lan devices` and
   `edge-daemon lan revoke <id>` do the same from a terminal.

When the phone can't change the car, the app says why and what to do. The
reasons are: not paired; PC not reachable (Wi-Fi, PC off, phone access off,
firewall); the PC's certificate changed (reinstalled or re-keyed, or another
device has its address); the phone was removed on the PC; or the PC refused it
(origin or too many attempts). Reading codes and live data with the phone's own
Bluetooth dongle keeps working in every case.

## Design

```
phone: web view ──postMessage──▶ app (Kotlin, OkHttp) ══TLS, pinned══▶ PC: edge daemon :8766
         ▲  Hello with the technician's                Origin + Authorization        │ same session code as
         └── cloud pairing token (unchanged)           (device credential)            ▼ loopback :8765
```

- **Off by default.** The daemon opens no network port unless phone access is
  enabled in `<data>/lan/config.json` (written by `edge-daemon lan enable`) or
  with `EDGE_LAN=on`. Enabling it needs administrator rights on the PC; a
  browser can never open the port.
- **A separate TLS listener** (default `0.0.0.0:8766`, `EDGE_LAN_PORT`,
  `EDGE_LAN_BIND`) next to the unchanged loopback listener. The certificate is
  a per-daemon self-signed ECDSA P-256 certificate made on first use
  (`<data>/lan/cert.der`, `key.der`, mode 0600). `edge-daemon lan rotate-cert`
  replaces it, and every phone then has to pair again.
- **The QR code** is
  `rootcause://lan-pair?v=1&h=<ip>&p=<port>&fp=<sha256 of the cert>&t=<code>&id=<daemon id>&n=<name>`.
  The phone pins `fp`. It trusts no certificate authority and no user-installed
  CA, only the exact certificate in the code (`modules/daemon-link`,
  `PinnedTrustManager`). The app checks the link before it connects anywhere
  (`src/lan/link.ts`).
- **Pairing.** The phone opens one pinned connection with
  `Authorization: RootCause-Pair <code>` and sends `LanPairRequest`. The daemon
  checks the code (single use, 5 minutes, at most 3 live, stored as SHA-256 in
  `<data>/pairing/lan_offers.json`). It answers once with a device id and a
  32-byte random secret, and keeps only the secret's SHA-256
  (`<data>/lan/devices.json`, 0600). The phone keeps the secret in Android
  Keystore-backed secure storage, and the web view never sees it.
- **Every later connection** must pass all of these checks in the upgrade
  request, before a WebSocket exists:
  - `Host` must be an IP literal or `*.local` with the listener's port. This
    stops DNS rebinding.
  - `Origin` must be present and in the daemon's allowed origins. The app sends
    its web origin, the same one the PC's browser uses.
  - `Authorization` must be `Bearer <device id>.<secret>` (compared in
    constant time against the hash).

  Anything else gets an HTTP 401 or 403, and the failure counts against the
  rate limit.
- **Technician identity is unchanged.** On top of the device credential, the
  web app still sends `HelloRequest` with the signed-in technician's cloud
  pairing token, which is bound to the web origin. Over the network, 6-digit
  local codes are refused, so a phone always acts as a named technician, and
  the daemon uses that technician's own lease (per-technician leases stay
  intact). A phone is bound to the workshop (tenant) of whoever made its
  pairing code, or for `edge-daemon lan pair`, the first technician who uses
  it. Technicians from another workshop are refused on it.
- **Management is PC-only.** `LanStatusRequest`, `LanPairOfferRequest` and
  `LanDeviceRevokeRequest` are answered only on loopback. A phone gets
  `LAN_UNAVAILABLE`.
- **Safety is unchanged.** Over the network, the same session code runs the
  same interlock: preconditions (speed, RPM, battery read by the daemon
  itself), single-use safety tokens, hold-to-confirm in the UI, Active mode
  only with a lease, and the immobilizer lease rules. The audit log now also
  records which phone made a change: `"client": "lan:<device id> (<name>)"`,
  next to the technician.
- **Revocation** removes the phone from the registry and closes its open
  connections at once (a broadcast to its sessions). Edits made with the
  command line while the service runs are picked up within 2 seconds.
- **Limits:**
  - 30 new connections per minute per address.
  - 5 failures block that address for 5 minutes.
  - At most 16 phone connections at once.
  - The TLS handshake must finish in 5 seconds and `HelloRequest` must arrive
    within 5 seconds.
  - At most 32 paired phones (the oldest is dropped).
- **Discovery (optional).** With `--mdns`, the daemon advertises
  `_rootcause-edge._tcp.local.` with its id. Phones pair by QR code either
  way. The app doesn't browse mDNS yet: if the PC's address changes, pair
  again. Giving the PC a DHCP reservation avoids that.
- **The web view relay.** A web view can't pin a self-signed certificate for
  `wss:` or set headers on a WebSocket, and it blocks mixed content. So the
  socket lives in native code (`modules/daemon-link`), and the web app talks to
  it through the bridge:
  - `daemon-open`, `daemon-send` and `daemon-close` go from the web app to the
    native side.
  - Frames come back batched through `window.RootCauseNativeDaemon.deliver`.

  See `apps/web/src/lib/native-daemon.ts` and `apps/mobile/src/lan/relay.ts`.
  The bridge only accepts messages from the RootCause web origin.

## Threat model

| Threat | Mitigation |
| --- | --- |
| Someone on the workshop Wi-Fi connects to the daemon | Port closed unless enabled; TLS; every connection needs a paired device credential *and* a technician's cloud token; per-IP rate limit and lockout |
| Fake PC (ARP/DNS spoofing, rogue AP) gets the phone's credential or commands | The phone pins the certificate fingerprint from the QR code and sends nothing until it matches; the pairing response must carry the daemon id from the code |
| Stolen or shoulder-surfed QR code | Single use, 5 minutes, max 3 live; the PC list shows every paired phone; remove revokes at once; the pairing code still doesn't give technician rights (cloud token needed) |
| Stolen phone | Remove it on the PC (closes connections, credential dead); the technician's cloud session can be signed out; the phone still needs the technician's signed-in session for Hello |
| Malicious web page in a browser on the network (CSRF, DNS rebinding) | Browsers can't send `Authorization` on WebSockets; `Origin` must be allowed; `Host` must be an IP literal or `.local` |
| Another workshop's technician uses a paired phone | Phone bound to one tenant; Hello from another tenant refused |
| Phone used to add or remove phones | Management messages refused over the network |
| Weakening car safety | None of the interlock code changed; network sessions go through the same `Session` handling; the audit log identifies the phone |
| Secrets at rest | Daemon stores only hashes (0600); phone keeps the secret in Keystore-backed secure storage; the web app only sees the PC's name, address and fingerprint start; nothing in git |
| Certificate key theft from the PC | Same trust level as the daemon's data folder (service account, 0600); `lan rotate-cert` re-keys, after which every phone must pair again |
| Denial of service on the network port | Connection rate limit, failure lockout, concurrency cap and handshake timeouts; loopback (the PC's own browser) is unaffected |

Not covered: a compromised PC or a compromised phone OS, as with the loopback
design. On a hostile network, mDNS records are visible to everyone; they carry
only the daemon id and port.

## PR #15 (Android plan licence): not rebuilt

PR #15 proposed that the Android app fetch the edge lease and verify it offline
on the phone (Ed25519, pinned keys) to gate features, including clearing codes
over Bluetooth. In this architecture that adds no security, so it isn't
rebuilt:

- **What the phone can do is already decided by the web app**, from the same
  `/auth/me` entitlements as the website. The server enforces those limits;
  hiding a button on the client is only for display.
- **Car changes from the phone run on the PC's daemon**, which verifies the
  technician's lease itself, against keys pinned in the daemon. A lease check
  on the phone would be a second, weaker copy: anyone controlling the phone
  could skip it.
- **The phone's own Bluetooth path stays read-only.** Its send guard
  allow-lists only reading services, whatever the plan. So there is no
  Bluetooth write left to gate with a licence.
- **Offline use** is covered by the daemon's lease. It lasts up to 72 h and is
  enforced on the PC.

If a future release lets the phone change a car over its own Bluetooth dongle,
the right home for that check is still the daemon (or an equivalent on-device
interlock with its own audit log), not a client-side licence check.

## Tests

| Where | What |
| --- | --- |
| `apps/edge-daemon/tests/lan_gate.rs` | Real TLS listener with a pinning client: off by default; pair, then per-technician leases, a gated `14FFFFFF` refused without a safety token and allowed with one, audit records phone and technician; management refused from a phone; revoke closes the socket and later connects get 401; pairing codes single-use; wrong pin refused; 403 for missing/foreign origin and DNS host; codes and foreign-origin tokens refused; other tenant refused; failures lead to a block; CLI pairing binds the first workshop; plain `ws:` refused |
| `apps/edge-daemon/src/server/lan.rs` (unit) | Settings and env overrides, identity files and modes, registry (hashes only, tenant binding, caps, CLI revocations, unreadable file ignored), offers, rate limiter, pairing link and QR |
| `apps/web/tests/native-daemon.test.ts`, `phone-access.test.tsx` | Relay transport, phone failure states, transport choice, QR rendering, Phone access card (off state, single-use code, remove with confirm, old daemon) |
| `apps/mobile/tests/lan.test.ts` | Pairing link validation, secure storage, pairing flow (pin, single use, wrong PC, timeout), relay batching and close semantics, bridge messages, bootstrap scripts |
| `services/cloud-api/tests/test_edge_pairing_origin.py` | Pairing tokens only for well-formed web origins |
| `apps/web/e2e/daemon-gate.spec.ts` | Against the real daemon with phone access on: the PC shows the code; a phone page with the app's bridge and a Node pinned-TLS link (as the Kotlin module does) pairs, the code works once, the phone connects with the technician's lease, scans and clears codes through the hold-to-confirm, the daemon audit shows `lan:<id> (Pixel 8)` and user `u1`; removing it on the PC cuts it off |
| `apps/web/e2e/phone-layout.spec.ts` | Pages fit a phone screen (a too-wide card had pushed the Scan, Clear codes and hold-to-confirm buttons off screen) |
| CI `mobile.yml` | Compiles the Kotlin module (`gradlew assembleDebug`) |

Not tested here: a physical Android phone on real Wi-Fi with the camera (the
build machine has no Android device). Check it by hand before release with the
steps above.
