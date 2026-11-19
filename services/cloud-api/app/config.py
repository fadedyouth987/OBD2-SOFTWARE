"""Runtime settings shared by the cloud API.

Data residency is enforced at startup: with DATA_RESIDENCY_ENFORCE=true the
service refuses to start in any AWS region other than ap-southeast-2.
"""

from functools import lru_cache

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

REQUIRED_REGION = "ap-southeast-2"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    aws_region: str = REQUIRED_REGION
    data_residency_enforce: bool = True
    # The API connects as the non-owner app role (A-ENG-5); RLS applies to it.
    database_url: str = "postgresql+psycopg://diag_app:diag_app@localhost:5432/diag"
    # Migrations and maintenance run as the owner (superuser or BYPASSRLS).
    migration_database_url: str = "postgresql+psycopg://diag:diag@localhost:5432/diag"
    # Secret-manager reference for the VIN HMAC key: env://VAR, file:///path, or
    # secretsmanager://... (resolved in production).
    vin_hmac_key_ref: str = "env://VIN_HMAC_KEY"
    redis_url: str = "redis://localhost:6379/0"
    s3_endpoint_url: str = "http://localhost:8333"
    s3_bucket: str = "automotive-traces-au"

    @model_validator(mode="after")
    def _check_residency(self) -> "Settings":
        if self.data_residency_enforce and self.aws_region != REQUIRED_REGION:
            raise ValueError(
                f"AWS_REGION={self.aws_region!r} violates data residency; "
                f"set AWS_REGION={REQUIRED_REGION} or DATA_RESIDENCY_ENFORCE=false (dev only)"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
