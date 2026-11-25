"""Runtime settings shared by the cloud API.

Data residency is enforced at startup: with DATA_RESIDENCY_ENFORCE=true the
service refuses to start in any AWS region other than ap-southeast-2.
"""

from functools import lru_cache
from pathlib import Path

REQUIRED_REGION = "ap-southeast-2"

# Repo-root .env (used by `just dev`) then the API-local .env, then cwd.
_REPO_ROOT = Path(__file__).resolve().parents[3]
_API_ROOT = Path(__file__).resolve().parents[2]
_ENV_FILES = (
    str(_REPO_ROOT / ".env"),
    str(_API_ROOT / ".env"),
    ".env",
)

try:
    from pydantic import model_validator
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class Settings(BaseSettings):
        model_config = SettingsConfigDict(env_file=_ENV_FILES, extra="ignore")

        aws_region: str = REQUIRED_REGION
        data_residency_enforce: bool = True
        database_url: str = "postgresql+psycopg://diag_app:diag_app@localhost:5432/diag"
        migration_database_url: str = "postgresql+psycopg://diag:diag@localhost:5432/diag"
        vin_hmac_key_ref: str = "env://VIN_HMAC_KEY"
        redis_url: str = "redis://localhost:6379/0"
        s3_endpoint_url: str = "http://localhost:8333"
        s3_bucket: str = "automotive-traces-au"
        # Static keys for the local S3 stand-in; empty in AWS, where the task role is used.
        s3_access_key_id: str = ""
        s3_secret_access_key: str = ""
        # Empty by default: signing and Stripe fail closed until set in the environment.
        cloud_signing_private_key_hex: str = ""
        auth_allow_dev_login: bool = False
        stripe_webhook_secret: str = ""
        stripe_secret_key: str = ""
        stripe_price_pro_month: str = ""
        stripe_price_pro_year: str = ""
        stripe_price_workshop_month: str = ""
        stripe_price_workshop_year: str = ""
        stripe_price_fleet_month: str = ""
        stripe_price_fleet_year: str = ""
        stripe_price_immo_month: str = ""
        stripe_price_immo_year: str = ""
        stripe_price_seat: str = ""
        stripe_price_site: str = ""
        stripe_price_ai_overage: str = ""
        stripe_ai_overage_enabled: bool = False
        stripe_past_due_grace_days: int = 7
        public_app_url: str = "http://localhost:3000"
        immo_feature_enabled: bool = False

        @model_validator(mode="after")
        def _check_residency(self) -> "Settings":
            if self.data_residency_enforce and self.aws_region != REQUIRED_REGION:
                raise ValueError(
                    f"AWS_REGION={self.aws_region!r} violates data residency; "
                    f"set AWS_REGION={REQUIRED_REGION} or DATA_RESIDENCY_ENFORCE=false (dev only)"
                )
            return self

        def price_id_for(self, tier: str, interval: str) -> str:
            key = f"stripe_price_{tier.lower()}_{interval.lower()}"
            return str(getattr(self, key, "") or "")

        def immo_price_id(self, interval: str) -> str:
            return str(getattr(self, f"stripe_price_immo_{interval.lower()}", "") or "")

        def price_catalog(self) -> dict[str, str]:
            return {
                "PRO:month": self.stripe_price_pro_month,
                "PRO:year": self.stripe_price_pro_year,
                "WORKSHOP:month": self.stripe_price_workshop_month,
                "WORKSHOP:year": self.stripe_price_workshop_year,
                "FLEET:month": self.stripe_price_fleet_month,
                "FLEET:year": self.stripe_price_fleet_year,
                "IMMO:month": self.stripe_price_immo_month,
                "IMMO:year": self.stripe_price_immo_year,
                "SEAT": self.stripe_price_seat,
                "SITE": self.stripe_price_site,
                "AI_OVERAGE": self.stripe_price_ai_overage,
            }

except ImportError:
    from pydantic import BaseSettings, root_validator  # type: ignore[no-redef]

    class Settings(BaseSettings):  # type: ignore[no-redef]
        aws_region: str = REQUIRED_REGION
        data_residency_enforce: bool = True
        database_url: str = "postgresql+psycopg://diag_app:diag_app@localhost:5432/diag"
        migration_database_url: str = "postgresql+psycopg://diag:diag@localhost:5432/diag"
        vin_hmac_key_ref: str = "env://VIN_HMAC_KEY"
        redis_url: str = "redis://localhost:6379/0"
        s3_endpoint_url: str = "http://localhost:8333"
        s3_bucket: str = "automotive-traces-au"
        # Static keys for the local S3 stand-in; empty in AWS, where the task role is used.
        s3_access_key_id: str = ""
        s3_secret_access_key: str = ""
        cloud_signing_private_key_hex: str = ""
        auth_allow_dev_login: bool = False
        stripe_webhook_secret: str = ""
        stripe_secret_key: str = ""
        stripe_price_pro_month: str = ""
        stripe_price_pro_year: str = ""
        stripe_price_workshop_month: str = ""
        stripe_price_workshop_year: str = ""
        stripe_price_fleet_month: str = ""
        stripe_price_fleet_year: str = ""
        stripe_price_immo_month: str = ""
        stripe_price_immo_year: str = ""
        stripe_price_seat: str = ""
        stripe_price_site: str = ""
        stripe_price_ai_overage: str = ""
        stripe_ai_overage_enabled: bool = False
        stripe_past_due_grace_days: int = 7
        public_app_url: str = "http://localhost:3000"
        immo_feature_enabled: bool = False

        class Config:
            env_file = _ENV_FILES
            extra = "ignore"

        @root_validator
        def _check_residency(cls, values: dict) -> dict:
            if (
                values.get("data_residency_enforce", True)
                and values.get("aws_region") != REQUIRED_REGION
            ):
                raise ValueError(
                    f"AWS_REGION={values.get('aws_region')!r} violates data residency; "
                    f"set AWS_REGION={REQUIRED_REGION} or DATA_RESIDENCY_ENFORCE=false (dev only)"
                )
            return values

        def price_id_for(self, tier: str, interval: str) -> str:
            key = f"stripe_price_{tier.lower()}_{interval.lower()}"
            return str(getattr(self, key, "") or "")

        def immo_price_id(self, interval: str) -> str:
            return str(getattr(self, f"stripe_price_immo_{interval.lower()}", "") or "")

        def price_catalog(self) -> dict[str, str]:
            return {}


@lru_cache
def get_settings() -> Settings:
    return Settings()
