# Dev OIDC provider

A local stand-in for AWS Cognito so sign-in with OIDC can be tried and tested
without an AWS account. It is for development only: any email signs in, and the
signing key lives in memory for one run. See `docs/dev/sign-in-oidc.md`.

```sh
cd services/cloud-api
uv run python ../../tools/dev-oidc-provider/server.py
```
