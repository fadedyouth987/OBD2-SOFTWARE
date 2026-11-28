"""The edge pairing token is bound to a web origin; only well-formed origins are accepted."""

import pytest
from pydantic import ValidationError

from app.api.v1.auth import PairingRequest


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://app.rootcauseobd.com.au",
        "https://app.rootcauseobd.com.au:8443",
        "http://[::1]:3000",
    ],
)
def test_web_origins_are_accepted(origin: str) -> None:
    assert PairingRequest(origin=origin).origin == origin


@pytest.mark.parametrize(
    "origin",
    [
        "",
        "null",
        "app.rootcauseobd.com.au",
        "https://app.rootcauseobd.com.au/",
        "https://app.rootcauseobd.com.au/devices",
        "https://app.rootcauseobd.com.au?x=1",
        "https://user@app.rootcauseobd.com.au",
        "HTTPS://APP.ROOTCAUSEOBD.COM.AU",
        "rootcause://lan-pair",
        "javascript:alert(1)",
        "https://app.rootcauseobd.com.au:99999",
        "https://app.rootcauseobd.com.au:0",
        "https://" + "a" * 300 + ".com",
        "https://app.rootcauseobd.com.au\n",
    ],
)
def test_anything_else_is_refused(origin: str) -> None:
    with pytest.raises(ValidationError):
        PairingRequest(origin=origin)
