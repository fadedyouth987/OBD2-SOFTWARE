"""Runtime settings shared by the cloud API.

Data residency is enforced at startup: with DATA_RESIDENCY_ENFORCE=true the
service refuses to start in any AWS region other than ap-southeast-2.
"""

from functools import lru_cache

REQUIRED_REGION = "ap-southeast-2"

try:
    from pydantic import model_validator
    from pydantic_settings import BaseSettings, SettingsConfigDict

    class Settings(BaseSettings):
        model_config = SettingsConfigDict(env_file=".env", extra="ignore")

        aws_region: str = REQUIRED_REGION
        data_residency_enforce: bool = True
        database_url: str = "postgresql+psycopg://diag_app:diag_app@localhost:5432/diag"
        migration_database_url: str = "postgresql+psycopg://diag:diag@localhost:5432/diag"
        vin_hmac_key_ref: str = "env://VIN_HMAC_KEY"
        redis_url: str = "redis://localhost:6379/0"
        s3_endpoint_url: str = "http://localhost:8333"
        s3_bucket: str = "automotive-traces-au"
        # Empty by default: signing and Stripe fail closed until set in the environment.
        cloud_signing_private_key_hex: str = ""
        auth_allow_dev_login: bool = False
        stripe_webhook_secret: str = ""

        @model_validator(mode="after")
        def _check_residency(self) -> "Settings":
            if self.data_residency_enforce and self.aws_region != REQUIRED_REGION:
                raise ValueError(
                    f"AWS_REGION={self.aws_region!r} violates data residency; "
                    f"set AWS_REGION={REQUIRED_REGION} or DATA_RESIDENCY_ENFORCE=false (dev only)"
                )
            return self
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
        cloud_signing_private_key_hex: str = ""
        auth_allow_dev_login: bool = False
        stripe_webhook_secret: str = ""

        class Config:
            env_file = ".env"
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
