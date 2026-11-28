# Sign-in with AWS Cognito or Google (OIDC)

The cloud API speaks OpenID Connect with the authorization-code flow, PKCE (S256), a
one-time `state` stored hashed in `oidc_login_states`, a `nonce` bound into the ID
token, and RS256 signatures checked against the provider's JWKS. Code lives in
`services/cloud-api/app/services/oidc.py`; the web pages are `/signin`,
`/auth/callback` and `/auth/link`.

## Choosing a provider

One provider at a time.

| Set | Provider | Redirect URI |
| --- | --- | --- |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (optional), `OIDC_REDIRECT_URI`, `OIDC_PROVIDER_NAME`, `OIDC_LOGOUT_URL` | AWS Cognito (or any OIDC provider) | `OIDC_REDIRECT_URI` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google (`https://accounts.google.com`) | `${PUBLIC_APP_URL}/auth/callback` |

- If both are set, `OIDC_ISSUER` wins and the API logs one warning saying
  `GOOGLE_CLIENT_ID is ignored`.
- Google's ID tokens carry `iss` as either `https://accounts.google.com` or
  `accounts.google.com`. Both are accepted for Google, and only for Google.
- Google receives the client secret in the token request body; other providers get
  HTTP Basic.
- For local work without a real provider, `tools/dev-oidc-provider/server.py` is a
  tiny fake issuer.

## New accounts

A first sign-in whose email matches no account creates one, but only when the provider
says the email is verified (`email_verified`). An invite token carried through
`/oidc/start` joins the inviting workshop.

## Existing accounts are never linked on the provider's word (review H3)

If a provider sign-in's email matches an account that isn't linked yet, nothing is
linked and no session is issued. Before this fix a Google account with the same email
was linked automatically, so anyone who controlled that email at the provider (for
example a re-registered or recycled address) could take the account over.

Now the callback returns **409** with:

```json
{"detail": {"code": "link_required", "provider": "Google", "link_token": "…",
            "email_sent": true, "email_hint": "j***@example.com", "message": "…"}}
```

and stores a request in `oidc_link_requests` (tokens hashed, 30 minutes, single use).
The account holder confirms in one of two ways:

1. **Signed in.** The web keeps `link_token` in `sessionStorage`, sends the person to
   `/signin?link=1`, and after they sign in with their password shows "Link Google?".
   Pressing Link calls `POST /api/v1/auth/oidc/link/confirm {token}` with their
   session. A different signed-in user gets 403.
2. **By email.** The account's address gets "Confirm signing in with Google" with a
   link to `/auth/link?token=…`. That page needs a button press (so mail scanners that
   prefetch links can't confirm) and calls `POST /api/v1/auth/oidc/link/email-confirm`.
   It links only; it never signs anyone in.

On either path the account's address gets a "Google sign-in was linked" email, the
`auth_oidc_linked` metric is incremented, and every other open request for that
account is closed. A request that has expired or was used returns 400. If the
identity or the account was linked meanwhile, 409.

An invite that started such a sign-in stays open; accept it from its link once signed
in (`invite_pending: true` in the confirm response).

## Tests

`services/cloud-api/tests/test_oidc.py` (fake Cognito) and `test_oidc_google.py`
(Google shorthand, issuer spellings, secret in the body, precedence warning).
`apps/web/tests/sso-link.test.ts` covers reading the 409.
