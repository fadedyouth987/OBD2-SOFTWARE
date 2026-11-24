"""Hybrid vector-first schematic-to-graph pipeline (Task 3.2)."""
from __future__ import annotations

from typing import Any

from app.vision.raster_extract import extract_raster_fallback
from app.vision.vector_extract import extract_vector_nodes, validate_pdf_limits


def run_schematic_pipeline(size_bytes: int, pages: list[str]) -> dict[str, Any]:
    validate_pdf_limits(size_bytes=size_bytes, page_count=len(pages))
    extracted: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, text in enumerate(pages, start=1):
        vec_nodes = extract_vector_nodes(text)
        page_nodes = vec_nodes if vec_nodes else extract_raster_fallback(idx, ocr_text=text)
        for node in page_nodes:
            nid = node["node_id"]
            if nid not in seen_ids:
                seen_ids.add(nid)
                extracted.append(node)
    return {"page_count": len(pages), "node_count": len(extracted), "nodes": extracted}
