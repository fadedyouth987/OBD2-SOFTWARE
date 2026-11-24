"""Unit tests for Tasks 2.2, 2.3, 3.3, and 5.2."""
import unittest

from app.services.ai_diagnostic_agent import diagnose_session, score_to_confidence_band
from app.services.anonymizer import anonymize_case
from app.services.embeddings import EMBEDDING_DIM, embed_canonical_text
from app.services.signing import PINNED_KID, issue_edge_lease, issue_pairing_jwt


class TestCloudServices(unittest.TestCase):
    def test_edge_lease_and_pairing_issue(self):
        lease = issue_edge_lease("tenant-1", "user-1", tier="WORKSHOP", dongle_id="RC-DGL-04A2")
        self.assertEqual(lease["kid"], PINNED_KID)
        self.assertEqual(len(lease["token"].split(".")), 3)

        pair = issue_pairing_jwt("tenant-1", "user-1", origin="http://localhost:3000")
        self.assertEqual(pair["origin"], "http://localhost:3000")
        self.assertEqual(len(pair["token"].split(".")), 3)

    def test_anonymizer_strips_vin_and_pii(self):
        out = anonymize_case({
            "vin": "MPBUMFF60PX418290",
            "engine_family": "3.0L V6",
            "dtcs": ["p2463"],
            "symptom_summary": "VIN MPBUMFF60PX418290 owner tech@shop.com.au 0412345678",
            "verified_fix": "Static DPF regen",
        })
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
        self.assertEqual(ok["mode"], "KG_RAG_SYNTHESIS")
        self.assertTrue(ok["quota_charged"])
        self.assertEqual(ok["ranked_causes"][0]["confidence_band"], "HIGH")

        fb = diagnose_session("sess-1", ["P2463"], llm_error="timeout")
        self.assertEqual(fb["mode"], "FALLBACK_NO_LLM")
        self.assertFalse(fb["quota_charged"])
        self.assertEqual(fb["ranked_causes"], [])


if __name__ == "__main__":
    unittest.main()
