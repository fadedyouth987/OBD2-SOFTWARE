"""Raster OCR fallback for scanned workshop wiring diagrams (Task 3.2)."""
from __future__ import annotations

from typing import Any

from app.vision.vector_extract import extract_vector_nodes


def extract_raster_fallback(page_index: int, ocr_text: str = "") -> list[dict[str, Any]]:
    """Extracts circuit nodes from raster OCR text when available, or emits a page-indexed bus node."""
    if ocr_text.strip():
        nodes = extract_vector_nodes(ocr_text)
        for n in nodes:
            n["source"] = "raster_ocr"
            n["page"] = page_index
        if nodes:
            return nodes
    return [
        {
            "node_id": f"NODE:SCHEMATIC_P{page_index}_HARNESS",
            "label": "HarnessSegment",
            "relation": "ON_BUS",
            "source": "raster_fallback",
            "page": page_index,
        }
    ]
