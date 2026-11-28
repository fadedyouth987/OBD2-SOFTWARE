# Licensing setup: plans, third-party access, website and Android

How a workshop gets licensed, and the one-off setup you (the operator) do so that it works.

## Who supplies what

| Licence | Supplied by | Paid to | In the product |
| --- | --- | --- | --- |
| RootCause plan (Community, Pro, Workshop, Fleet, IMMO add-on) | RootCause | RootCause, through Stripe | Website **Workshop → Plan & billing**. Becomes a signed lease that the edge daemon and the Android app verify offline. |
| Workshop AASRA membership | AASRA | AASRA | The owner sends the member number, ABN and evidence on **Workshop**; a platform admin approves it in **Accreditation review**. |
| Technician security accreditation | AASRA (security upgrade, includes a police check) | AASRA, per technician | Each technician sends theirs on **Key programming**; same admin review. |
| Carmaker repair information | Each carmaker (or through AASRA's portal) | The carmaker | Not resold. Workshops upload the wiring diagrams they buy; they stay tenant-private. |
| Secure gateway access (Stellantis, Nissan, Mercedes-Benz) | AutoAuth | AutoAuth (+ carmaker fee) | **Not available yet.** RootCause has to be a certified tool first (below). |

RootCause can't sell the last four. Under the Motor Vehicle Information Scheme, security information goes only to individuals who meet the access criteria, and anyone who supplies scheme information becomes a "data provider" with the carmakers' obligations. Workshops see this list, with live status, at **Workshop → Licences & access** (`/workshop/licences`).

AASRA fees quoted in Treasury's MVIS review final report (February 2026): base membership A$90 + GST a year; safety upgrade A$50 and security upgrade A$210 per technician a year. Check aasra.com.au for current fees before quoting them to customers.

## 1. Stripe (the RootCause plan)

1. **Account**: an Australian Stripe account in AUD.
2. **Products and prices**: one product per plan with a monthly and a yearly recurring price (annual is 10 × monthly), plus the IMMO add-on. Set each price ID in the API's environment:

   | Variable | Price |
   | --- | --- |
   | `STRIPE_PRICE_PRO_MONTH` / `_YEAR` | Pro A$39 / A$390 |
   | `STRIPE_PRICE_WORKSHOP_MONTH` / `_YEAR` | Workshop A$99 / A$990 |
   | `STRIPE_PRICE_FLEET_MONTH` / `_YEAR` | Fleet A$229 / A$2,290 |
   | `STRIPE_PRICE_IMMO_MONTH` / `_YEAR` | IMMO add-on A$49 / A$490 |

   The API maps webhooks to plans by these price IDs, never by metadata, so an unknown price grants nothing.
3. **Keys**: `STRIPE_SECRET_KEY` (restricted key with Checkout, Customer Portal and Subscriptions access).
4. **Webhook**: endpoint `https://<api host>/api/v1/billing/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`. Failures: `docs/runbooks/stripe-webhook-failures.md`.
5. **Customer Portal**: turn it on (Settings → Billing → Customer portal) with invoice history, payment method updates, cancellation and plan switching between the prices above.
6. **GST (Stripe Tax)**: register for GST with the ATO once turnover reaches A$75,000 (or earlier by choice). Then in Stripe: Tax → Registrations → add Australia, set a SaaS product tax code on each product, and set each price's tax behaviour. Then set `STRIPE_AUTOMATIC_TAX=true`: Checkout adds GST, requires the billing address and collects the workshop's ABN for the tax invoice.
   - **Decision needed:** the website shows "A$39". Either make prices GST-inclusive (tax behaviour *inclusive*), or keep them exclusive and change the billing page to say "+ GST".
7. **Test**: in test mode, `stripe listen --forward-to localhost:8000/api/v1/billing/webhook`, buy a plan on `/workshop/billing` with card 4242 4242 4242 4242, and check the plan changes on the page and on **Devices** after a lease refresh.

## 2. AASRA

- Accreditation review in RootCause is manual by design: AASRA has no public verification API (`services/cloud-api/app/services/aasra.py`).
- **Ask AASRA** (via aasra.com.au → Contact): is there a verification service or API for diagnostic software, and how should third-party software use a technician's AASRA credentials or Vehicle Security Professional ID? A "yes" lets us replace the manual review with an automatic check.

## 3. AutoAuth (secure gateways)

Workshops can only register tools from certified vendors, and certification is tied to a market.

- **Apply** for AutoAuth tool-vendor certification. AutoAuth says the tool service is free for Equipment and Tool Institute (ETI) members. Ask whether it covers Australian-market vehicles.
- Carmakers also license gateway access to tool makers; Stellantis gave the integration details only to tool makers with a scan-tool licence agreement.
- Until certified, the Licences page says "Not available yet". **Note:** `POST /api/v1/gateways/sgw/unlock` currently returns `"status": "unlocked"` after only an AASRA check, without contacting AutoAuth. Nothing in the web app or the Android app calls it. Change it to say it's not available (or remove it) before anyone builds on it.

## 4. Android app

- **No purchasing in the app.** It's a consumption-only app under Google Play's payments policy: users sign in and use the plan bought on the website. Keep prices, "buy" buttons and purchase links out of the app; Play requires its own billing for in-app sales of subscriptions. (Since September 2026, Australian apps may also link to outside checkout under the Epic–Google settlement, with Google's reduced fee. Not needed here.)
- **Sign-in**: email and password (`POST /api/v1/auth/login`), so `AUTH_PASSWORD_ENABLED` must stay on for app users. Google/OIDC sign-in in the app is a follow-up.
- **Licence**: the app calls `POST /api/v1/auth/edge-lease` and verifies the token offline with the daemon's rules (`data/Licence.kt`). Paid leases last 12 h and the sign-in session 12 h, so a technician signs in about once a day. Refresh tokens would remove that; follow-up.
- **Release build**:
  1. Pin the production public key in both the daemon and the app: `python3 scripts/export_cloud_keys.py --pubkey-hex <hex> --kid <kid> --kotlin-out apps/android/app/src/main/java/au/com/rootcauseobd/fleet/data/CloudKeys.kt`. With nothing pinned, release builds run on Community whatever the plan.
  2. Build with the production API address: `./gradlew assembleRelease -Prootcause.cloudApiUrl=https://<api host>`.
- **Debug build**: starts at `http://10.0.2.2:8000` (the host's `just dev` API from the emulator) and also trusts that server's `/api/v1/auth/jwks`, so local development works without pinning.
- **What the licence gates**: clearing codes over Bluetooth needs `UDS_ACTIVE` (Pro and up). Reading codes and live data stay free. With an edge daemon, the app installs the licence on the daemon after pairing, and the daemon enforces it.
