#!/usr/bin/env python3
"""Print EDGE_DEV_CLOUD_KEYS for a debug edge-daemon from the local API's JWKS.

Usage: curl -s http://127.0.0.1:8000/api/v1/auth/jwks | python3 scripts/dev_cloud_keys.py

Development only. Release daemon builds ignore EDGE_DEV_CLOUD_KEYS; production
keys are pinned with scripts/export_cloud_keys.py instead.
"""

from __future__ import annotations

import base64
import json
import sys


def main() -> int:
    jwks = json.load(sys.stdin)
    pairs = []
    for key in jwks.get("keys", []):
        if key.get("kty") != "OKP" or key.get("crv") != "Ed25519":
            continue
        x = key["x"] + "=" * (-len(key["x"]) % 4)
        raw = base64.urlsafe_b64decode(x)
        if len(raw) != 32:
            continue
        pairs.append(f"{key['kid']}:{raw.hex()}")
    if not pairs:
        print("no Ed25519 keys in the JWKS", file=sys.stderr)
        return 1
    print("EDGE_DEV_CLOUD_KEYS=" + ",".join(pairs))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
