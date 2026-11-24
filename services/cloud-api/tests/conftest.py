"""Process-wide test defaults so session signing is available before app import."""

import os

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("AUTH_ALLOW_DEV_LOGIN", "true")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_local_not_prod")

os.environ.setdefault("VIN_HMAC_KEY_REF", "env://VIN_HMAC_KEY")
os.environ.setdefault("VIN_HMAC_KEY", "test-only-vin-hmac-key-0123456789")
