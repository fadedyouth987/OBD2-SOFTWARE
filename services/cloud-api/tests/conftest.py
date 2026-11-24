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
