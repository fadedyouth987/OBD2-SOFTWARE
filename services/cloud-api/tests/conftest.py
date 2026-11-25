"""Process-wide test defaults so session signing is available before app import."""

import os

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("AUTH_ALLOW_DEV_LOGIN", "true")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_local_not_prod")
os.environ.setdefault("STRIPE_SECRET_KEY", "sk_test_local_not_prod")
os.environ["STRIPE_PRICE_PRO_MONTH"] = "price_test_pro_month"
os.environ["STRIPE_PRICE_PRO_YEAR"] = "price_test_pro_year"
os.environ["STRIPE_PRICE_WORKSHOP_MONTH"] = "price_test_workshop_month"
os.environ["STRIPE_PRICE_WORKSHOP_YEAR"] = "price_test_workshop_year"
os.environ["STRIPE_PRICE_FLEET_MONTH"] = "price_test_fleet_month"
os.environ["STRIPE_PRICE_FLEET_YEAR"] = "price_test_fleet_year"
os.environ["STRIPE_PRICE_IMMO_MONTH"] = "price_test_immo_month"
os.environ["STRIPE_PRICE_IMMO_YEAR"] = "price_test_immo_year"

os.environ.setdefault("VIN_HMAC_KEY_REF", "env://VIN_HMAC_KEY")
os.environ.setdefault("VIN_HMAC_KEY", "test-only-vin-hmac-key-0123456789")
# The older immo tests enrol and expect approval on submit; that shortcut only
# exists behind this explicit local flag (with AUTH_ALLOW_DEV_LOGIN). Tests of
# the reviewed workflow switch it off.
os.environ.setdefault("AASRA_DEV_AUTO_APPROVE", "true")
# Keep tests independent of a developer's local .env (which may turn on the dev
# OIDC provider or a file mailbox). Tests that need these set them themselves.
os.environ["EMAIL_PROVIDER"] = "none"
os.environ["OIDC_ISSUER"] = ""
os.environ["AUTH_PASSWORD_ENABLED"] = "true"
os.environ["PROCEDURE_PROVIDER_FEED_URL"] = ""
os.environ["LLM_PROVIDER"] = "none"
