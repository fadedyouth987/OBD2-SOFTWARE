"""Vector-first PDF schematic text/wire extractor (Task 3.2, A-ENG-8)."""

from __future__ import annotations

import re
from typing import Any

MAX_PDF_BYTES = 50 * 1024 * 1024  # 50 MB limit (A-ENG-8)
MAX_PDF_PAGES = 200  # 200 page limit (A-ENG-8)

_NODE_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b(F\d{1,3}[A-Z]?)\b", re.IGNORECASE), "Fuse", "POWERED_BY"),
    (re.compile(r"\b(G\d{2,4})\b", re.IGNORECASE), "Ground", "GROUNDED_AT"),
    (re.compile(r"\b(X\d{2,4})\b", re.IGNORECASE), "Connector", "CONNECTED_VIA"),
    (re.compile(r"\b(S\d{2,4})\b", re.IGNORECASE), "Splice", "SPLICED_AT"),
    (
        re.compile(r"\b(HS[-_]?CAN|MS[-_]?CAN|PT[-_]?CAN|K[-_]?LINE)\b", re.IGNORECASE),
        "Bus",
        "ON_BUS",
    ),
]


def validate_pdf_limits(size_bytes: int, page_count: int) -> None:
    if size_bytes > MAX_PDF_BYTES:
        raise ValueError(f"PDF exceeds 50 MB limit ({size_bytes} bytes)")
    if page_count > MAX_PDF_PAGES:
        raise ValueError(f"PDF exceeds 200 page limit ({page_count} pages)")


def extract_vector_nodes(page_text: str) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rx, label, rel in _NODE_PATTERNS:
        for match in rx.finditer(page_text):
            raw = match.group(1).upper().replace("-", "_")
            node_id = f"NODE:{raw}"
            if node_id not in seen:
                seen.add(node_id)
                nodes.append(
                    {"node_id": node_id, "label": label, "relation": rel, "source": "vector"}
                )
    return nodes
