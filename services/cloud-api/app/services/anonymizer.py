"""PII & tenant scrubber for shared resolved_cases corpus (Task 2.2, A-CEO-6)."""
from __future__ import annotations

import re
from typing import Any

_VIN_RE = re.compile(r"\b[A-HJ-NPR-Z0-9]{17}\b")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"\b(?:\+?61|0)[2-478](?:[ -]?\d){8}\b")


def scrub_text(text: str) -> str:
    cleaned = _VIN_RE.sub("[VIN_REDACTED]", text)
    cleaned = _EMAIL_RE.sub("[EMAIL_REDACTED]", cleaned)
    cleaned = _PHONE_RE.sub("[PHONE_REDACTED]", cleaned)
    return cleaned


def anonymize_case(raw_case: dict[str, Any]) -> dict[str, Any]:
    """Removes tenant/user identifiers and full VINs; keeps WMI+VDS (positions 1-9) only."""
    vin = str(raw_case.get("vin", ""))
    wmi_vds = vin[:9] if len(vin) >= 9 else raw_case.get("wmi_vds", "UNKNOWN")
    return {
        "wmi_vds": wmi_vds,
        "engine_family": str(raw_case.get("engine_family", "unknown")),
        "dtcs": sorted({str(c).upper() for c in raw_case.get("dtcs", [])}),
        "symptom_summary": scrub_text(str(raw_case.get("symptom_summary", ""))),
        "verified_fix": scrub_text(str(raw_case.get("verified_fix", ""))),
        "parts_replaced": [scrub_text(str(p)) for p in raw_case.get("parts_replaced", [])],
    }
