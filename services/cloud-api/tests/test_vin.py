import pytest

from app.db.vin import normalize_vin, resolve_secret, vin_hmac, wmi_vds

KEY = b"test-only-vin-hmac-key-0123456789"


def test_hmac_is_stable_keyed_and_never_the_vin():
    h = vin_hmac(" wbavb11060pt00001 ", KEY)
    assert h == vin_hmac("WBAVB11060PT00001", KEY)
    assert len(h) == 64 and "WBAVB" not in h
    assert h != vin_hmac("WBAVB11060PT00001", KEY + b"x")
    assert h != vin_hmac("WBAVB11060PT00002", KEY)


def test_wmi_vds_drops_the_serial():
    assert wmi_vds("WBAVB11060PT00001") == "WBAVB1106"


@pytest.mark.parametrize("bad", ["", "WBAVB11060PT0000", "WBAVB11060PT000011", "WBAVB11060PT0000I"])
def test_invalid_vins_are_rejected(bad):
    with pytest.raises(ValueError):
        normalize_vin(bad)


def test_short_keys_and_unknown_secret_refs_are_refused(monkeypatch):
    with pytest.raises(ValueError):
        vin_hmac("WBAVB11060PT00001", b"short")
    monkeypatch.setenv("TEST_VIN_KEY", "k" * 32)
    assert resolve_secret("env://TEST_VIN_KEY") == b"k" * 32
    with pytest.raises(RuntimeError):
        resolve_secret("env://MISSING_TEST_VIN_KEY")
    with pytest.raises(RuntimeError):
        resolve_secret("secretsmanager://ap-southeast-2/obd2-diag/vin-hmac-key")
