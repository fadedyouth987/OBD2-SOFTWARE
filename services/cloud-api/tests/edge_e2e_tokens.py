"""Real cloud tokens for the web app's daemon gate (Task 4.1, `apps/web/e2e/daemon-gate.spec.ts`).

The Playwright gate stands in for the cloud API but must hand the browser
pairing and lease tokens that a real daemon verifies. They are issued here by
the production functions in ``signing.py``, with a throwaway key the test
generates per run and pins in a debug daemon (``EDGE_DEV_CLOUD_KEYS``).

    CLOUD_SIGNING_PRIVATE_KEY_HEX=<64 hex> CLOUD_SIGNING_KID=<kid> \
    E2E_TENANT=t1 E2E_USER=u1 E2E_ORIGIN=http://127.0.0.1:3100 \
    uv run python -m tests.edge_e2e_tokens key|pairing|lease

Prints one JSON object: ``{"keys": "kid:hex"}``, ``{"token": ...}``.
"""

from __future__ import annotations

import json
import os
import sys

from app.services import signing


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"key", "pairing", "lease"}:
        print(__doc__, file=sys.stderr)
        return 2
    if not os.environ.get("CLOUD_SIGNING_PRIVATE_KEY_HEX"):
        print("CLOUD_SIGNING_PRIVATE_KEY_HEX is required (a throwaway test key)", file=sys.stderr)
        return 2
    tenant = os.environ.get("E2E_TENANT", "t1")
    user = os.environ.get("E2E_USER", "u1")
    what = argv[1]
    if what == "key":
        out = {"keys": f"{signing.PINNED_KID}:{signing.public_key_raw().hex()}"}
    elif what == "pairing":
        out = {"token": signing.issue_pairing_jwt(tenant, user, os.environ["E2E_ORIGIN"])["token"]}
    else:
        out = signing.issue_edge_lease(
            tenant_id=tenant,
            user_id=user,
            tier=os.environ.get("E2E_TIER", "WORKSHOP"),
            aasra_verified=False,
            dongle_id=None,
            lease_version=1,
        )
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
