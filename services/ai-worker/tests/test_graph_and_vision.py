"""Unit tests for Tasks 3.1 (A-ENG-6) and 3.2 (A-ENG-8)."""
import unittest

from app.graph.neo4j_client import TenantScopedGraphRepository
from app.vision.schematic_pipeline import run_schematic_pipeline
from app.vision.vector_extract import MAX_PDF_BYTES, MAX_PDF_PAGES


class TestAiWorker(unittest.TestCase):
    def test_neo4j_requires_tenant_id(self):
        repo = TenantScopedGraphRepository()
        with self.assertRaises(ValueError):
            repo.query_shared_dependencies("", ["PCM"])
        res = repo.query_shared_dependencies("tenant-au-1", ["PCM", "BCM"])
        self.assertIn("tenant_id: $tenant_id", res["cypher"])

    def test_pdf_limits_and_hybrid_extract(self):
        with self.assertRaises(ValueError):
            run_schematic_pipeline(MAX_PDF_BYTES + 1, ["F104 G101"])
        with self.assertRaises(ValueError):
            run_schematic_pipeline(1024, ["F104"] * (MAX_PDF_PAGES + 1))

        out = run_schematic_pipeline(2048, ["Fuse F104 to Ground G101", "scanned image only"])
        self.assertEqual(out["page_count"], 2)
        node_ids = [n["node_id"] for n in out["nodes"]]
        self.assertIn("NODE:F104", node_ids)
        self.assertIn("NODE:G101", node_ids)
        self.assertIn("NODE:SCHEMATIC_P2_HARNESS", node_ids)


if __name__ == "__main__":
    unittest.main()
