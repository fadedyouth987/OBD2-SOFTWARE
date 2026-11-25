"""Unit tests for Tasks 2.2, 2.3, 3.3, and 5.2."""

import os
import unittest

from app.services.ai_diagnostic_agent import diagnose_session, score_to_confidence_band
from app.services.anonymizer import anonymize_case
from app.services.embeddings import EMBEDDING_DIM, embed_canonical_text
from app.services.signing import (
    PINNED_KID,
    SigningKeyError,
    features_for_tier,
    issue_edge_lease,
    issue_pairing_jwt,
    issue_session_jwt,
    verify_session_jwt,
)

TEST_KEY = "ab" * 32


class TestCloudServices(unittest.TestCase):
    def setUp(self):
        os.environ["CLOUD_SIGNING_PRIVATE_KEY_HEX"] = TEST_KEY

    def test_edge_lease_and_pairing_issue(self):
        lease = issue_edge_lease("tenant-1", "user-1", tier="WORKSHOP", dongle_id="RC-DGL-04A2")
        self.assertEqual(lease["kid"], PINNED_KID)
        self.assertEqual(len(lease["token"].split(".")), 3)
        self.assertEqual(set(lease["features"]), {"UDS_ACTIVE", "CAN_RE_PRO", "J2534"})

        pair = issue_pairing_jwt("tenant-1", "user-1", origin="http://localhost:3000")
        self.assertEqual(pair["origin"], "http://localhost:3000")
        self.assertEqual(len(pair["token"].split(".")), 3)

    def test_signing_fails_closed_without_a_key(self):
        os.environ.pop("CLOUD_SIGNING_PRIVATE_KEY_HEX", None)
        with self.assertRaises(SigningKeyError):
            issue_edge_lease("tenant-1", "user-1")

    def test_unknown_features_are_dropped(self):
        granted = features_for_tier(
            "WORKSHOP", ["UDS_ACTIVE", "IMMO_AUTH", "SGW_UNLOCK", "CAN_STUDIO"]
        )
        self.assertEqual(granted, ["UDS_ACTIVE"])
        lease = issue_edge_lease(
            "t", "u", tier="WORKSHOP", features=["IMMO_AUTH", "SGW_UNLOCK", "CAN_RE_PRO"]
        )
        self.assertEqual(lease["features"], ["CAN_RE_PRO"])
        self.assertNotIn("IMMO_AUTH", lease["features"])

    def test_session_jwt_round_trip(self):
        issued = issue_session_jwt("tenant-1", "user-1")
        claims = verify_session_jwt(issued["access_token"])
        self.assertEqual(claims["aud"], "cloud-api")
        self.assertEqual(claims["tenant_id"], "tenant-1")
        self.assertEqual(claims["user_id"], "user-1")

    def test_anonymizer_strips_vin_and_pii(self):
        out = anonymize_case(
            {
                "vin": "MPBUMFF60PX418290",
                "engine_family": "3.0L V6",
                "dtcs": ["p2463"],
                "symptom_summary": "VIN MPBUMFF60PX418290 owner tech@shop.com.au 0412345678",
                "verified_fix": "Static DPF regen",
            }
        )
        self.assertEqual(out["wmi_vds"], "MPBUMFF60")
        self.assertNotIn("MPBUMFF60PX418290", out["symptom_summary"])
        self.assertNotIn("tech@shop.com.au", out["symptom_summary"])
        self.assertEqual(out["dtcs"], ["P2463"])

    def test_embeddings_dimension(self):
        vec = embed_canonical_text("P2463 DPF soot")
        self.assertEqual(len(vec), EMBEDDING_DIM)

    def test_ai_agent_bands_and_fallback(self):
        self.assertEqual(score_to_confidence_band(0.9), "HIGH")
        self.assertEqual(score_to_confidence_band(0.6), "MEDIUM")
        self.assertEqual(score_to_confidence_band(0.2), "LOW")

        ok = diagnose_session("sess-1", ["P2463"])
        self.assertEqual(ok["mode"], "RULES")
        self.assertEqual(ok["analysis"], "rules")
        # The built-in rules are free: only a model answer is charged (by the route).
        self.assertFalse(ok["quota_charged"])
        self.assertEqual(ok["ranked_causes"][0]["cited_case_ids"], [])
        self.assertIn(ok["ranked_causes"][0]["confidence_band"], {"LOW", "MEDIUM", "HIGH"})

        supported = diagnose_session(
            "sess-1",
            ["P2463"],
            matched_cases=[
                {"case_id": "CASE-REAL-7", "dtcs": ["P2463"], "verified_fix": "hose"},
                {"case_id": "CASE-REAL-8", "dtcs": ["P2463"], "verified_fix": "sensor"},
            ],
        )
        self.assertEqual(
            supported["ranked_causes"][0]["cited_case_ids"],
            ["CASE-REAL-7", "CASE-REAL-8"],
        )
        self.assertEqual(supported["ranked_causes"][0]["confidence_band"], "HIGH")

    def test_fleet_is_a_real_tier_and_paid_leases_are_short(self):
        import time

        from app.services.signing import PAID_LEASE_TTL_S, normalize_tier

        self.assertEqual(normalize_tier("FLEET"), "FLEET")
        lease = issue_edge_lease("t", "u", tier="FLEET")
        self.assertEqual(lease["tier"], "FLEET")
        self.assertEqual(set(lease["features"]), {"UDS_ACTIVE", "CAN_RE_PRO", "J2534"})
        now = int(time.time())
        self.assertLessEqual(lease["expires_at"] - now, PAID_LEASE_TTL_S + 2)
        self.assertGreater(lease["expires_at"] - now, PAID_LEASE_TTL_S - 5)

        community = issue_edge_lease("t", "u", tier="COMMUNITY")
        self.assertEqual(community["features"], [])
        self.assertGreater(community["expires_at"] - now, 24 * 3600)

        entitled = issue_edge_lease("t", "u", tier="WORKSHOP", immo_entitled=True, lease_version=7)
        self.assertIn("IMMO_PROGRAM", entitled["features"])
        import base64
        import json

        payload = entitled["token"].split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        self.assertEqual(claims["lease_ver"], 7)
        self.assertEqual(claims["tier"], "WORKSHOP")


if __name__ == "__main__":
    unittest.main()
