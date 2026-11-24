"""Process-wide test defaults so session signing is available before app import."""

import os

os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ.setdefault("CLOUD_SIGNING_PRIVATE_KEY_HEX", "cd" * 32)
os.environ.setdefault("AUTH_ALLOW_DEV_LOGIN", "true")
os.environ.setdefault("STRIPE_WEBHOOK_SECRET", "whsec_test_local_not_prod")
