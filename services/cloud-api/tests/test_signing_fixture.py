"""The cross-language token fixture is current (Task 2.2 gate, Python half).

The Rust half is ``apps/edge-daemon/tests/cloud_token_fixture.rs``.
"""

import base64
import json

from tests import signing_fixture as fx


def _claims(token: str) -> dict:
    body = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def _header(token: str) -> dict:
    head = token.split(".")[0]
    return json.loads(base64.urlsafe_b64decode(head + "=" * (-len(head) % 4)))


def test_fixture_matches_signing_code():
    assert fx.FIXTURE.read_text() == fx.render(), (
        "signing.py changed what it signs; regenerate with "
        "`uv run python -m tests.signing_fixture --write` and re-run the Rust fixture test"
    )


def test_fixture_tokens_carry_the_production_shape():
    data = fx.build()
    lease, pairing = data["valid"]["lease"], data["valid"]["pairing"]
    assert _header(lease) == {"alg": "EdDSA", "typ": "JWT", "kid": fx.KID}
    assert _claims(lease)["aud"] == "edge-daemon" and _claims(pairing)["aud"] == "edge-ws"
    assert _claims(pairing)["origin"] == fx.ORIGIN
    # The fixture key is not the key the rest of the suite signs with.
    from app.services import signing

    assert data["public_key_hex"] != signing.public_key_raw().hex()
