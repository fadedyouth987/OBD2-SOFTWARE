import pytest
from pydantic import ValidationError

from app.config import Settings


def test_default_region_is_sydney() -> None:
    assert Settings().aws_region == "ap-southeast-2"


def test_other_region_refused_when_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("DATA_RESIDENCY_ENFORCE", "true")
    with pytest.raises(ValidationError, match="violates data residency"):
        Settings()


def test_other_region_allowed_only_when_enforcement_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("DATA_RESIDENCY_ENFORCE", "false")
    assert Settings().aws_region == "us-east-1"
