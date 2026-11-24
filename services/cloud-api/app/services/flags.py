"""Environment gates that must be read live (not through a cached Settings)."""

from __future__ import annotations

import os


def env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}


def auth_allow_dev_login() -> bool:
    return env_flag("AUTH_ALLOW_DEV_LOGIN")


def immo_feature_enabled() -> bool:
    """Immobilizer product flag. Off by default; pricing/tier still open."""
    return env_flag("IMMO_FEATURE_ENABLED")
