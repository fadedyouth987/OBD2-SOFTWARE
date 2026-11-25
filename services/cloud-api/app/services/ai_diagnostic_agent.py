"""KG-guided root-cause localizer and repair assistant (Task 3.3, A-CEO-1).

Two engines produce the same response shape:

- ``rules``: the built-in, evidence-scored rules over the vehicle platform's
  circuit graph and the workshop's resolved cases. Always available, free.
- ``llm``: a language model (``app.services.llm``) given the same evidence and
  the rules' ranking, asked to reason over it. Its answer is checked: it may
  only cite circuit nodes and case IDs it was given, and only for the DTCs
  asked about. Anything else is dropped; an answer with nothing left is
  treated as a failure.

Only a successful ``llm`` answer consumes AI quota; the route charges first and
refunds when the model fails, so a fallback never costs the workshop anything.
"""

from __future__ import annotations

import json
from typing import Any

from app.services.embeddings import EMBEDDING_MODEL, embed_canonical_text
from app.services.llm import LlmError, LlmProvider
from app.services.vehicle_registry import get_vehicle_platform

ENGINE_RULES = "rules"
ENGINE_LLM = "llm"
RULES_LABEL = "Built-in rules"
BANDS = ("HIGH", "MEDIUM", "LOW")


def score_to_confidence_band(score: float) -> str:
    """A-DES-4: Always return HIGH, MEDIUM, or LOW band instead of raw percentages."""
    if score >= 0.80:
        return "HIGH"
    if score >= 0.55:
        return "MEDIUM"
    return "LOW"


def _build_guided_steps(
    code: str, platform: dict[str, Any], primary_node: str
) -> list[dict[str, str]]:
    make_model = f"{platform['make']} {platform['model']}"
    return [
        {
            "step": "1. Pre-Scan & Bus Health",
            "action": (
                f"Confirm KOEO battery >= 12.5V and scan all modules on "
                f"{make_model} ({', '.join(platform['protocols'])})."
            ),
            "safety_tier": "SILENT",
        },
        {
            "step": "2. Pinpoint Circuit Test",
            "action": (
                f"Back-probe {primary_node} with a multimeter; verify "
                f"<0.2V drop under load and clean 5V/12V reference."
            ),
            "safety_tier": "SILENT",
        },
        {
            "step": "3. Active / Service Verification",
            "action": (
                f"Command actuator/bidirectional check or service reset "
                f"for {code} after mechanical/wiring repair."
            ),
            "safety_tier": "TIER A / B",
        },
        {
            "step": "4. Post-Scan & Clear",
            "action": (
                f"Run Mode 0x04 Clear DTCs (1.5s hold-to-confirm) and "
                f"verify {code} does not return on road test."
            ),
            "safety_tier": "TIER A",
        },
    ]


def diagnose_session(
    session_id: str,
    dtcs: list[str],
    shared_graph_nodes: list[str] | None = None,
    matched_cases: list[dict[str, Any]] | None = None,
    vehicle_profile: str = "ford_ranger_px3",
) -> dict[str, Any]:
    """The rules engine: a ranked diagnosis citing only known graph nodes and real case IDs."""
    platform = get_vehicle_platform(vehicle_profile)
    nodes = shared_graph_nodes or platform["shared_nodes"]
    cases = matched_cases or []
    canonical = f"session={session_id} profile={vehicle_profile} dtcs={','.join(sorted(dtcs))}"
    _embedding = embed_canonical_text(canonical)

    ranked = []
    for code in dtcs or ["P0000"]:
        matching_for_dtc = [
            c for c in cases if code.upper() in [str(d).upper() for d in c.get("dtcs", [])]
        ]
        # Evidence-based score: start low, add for a platform note and each
        # real matching case. Never invent case IDs or a fixed 0.90/0.85/0.64.
        known_note = platform.get("common_dtcs", {}).get(code.upper())
        score = 0.35
        if known_note:
            score += 0.20
        score += min(0.20 * len(matching_for_dtc), 0.50)
        band = score_to_confidence_band(score)
        cited_case_ids = [str(c.get("case_id")) for c in matching_for_dtc if c.get("case_id")]
        fix_hint = (
            matching_for_dtc[0].get("verified_fix")
            if matching_for_dtc and matching_for_dtc[0].get("verified_fix")
            else known_note
            or f"Shared power/ground or bus dependency affecting {code} across {nodes[0]}."
        )
        ranked.append(
            {
                "dtc": code,
                "confidence_band": band,
                "cited_nodes": nodes[:2],
                "cited_case_ids": cited_case_ids,
                "hypothesis": fix_hint,
                "multimeter_test": (
                    f"Verify <0.2V drop across {nodes[0]} under KOEO load before replacing module."
                ),
                "guided_steps": _build_guided_steps(code, platform, nodes[0]),
            }
        )

    return {
        "session_id": session_id,
        "vehicle": f"{platform['make']} {platform['model']}",
        "engine": platform["engine"],
        "modules": platform["modules"],
        "mode": "RULES",
        "analysis": ENGINE_RULES,
        "analysis_label": RULES_LABEL,
        "summary": None,
        "quota_charged": False,
        "embedding_model": EMBEDDING_MODEL,
        "shared_circuit_nodes": nodes,
        "matched_cases": cases,
        "ranked_causes": ranked,
    }


def answer_technician_followup(
    session_id: str,
    question: str,
    vehicle_profile: str = "ford_ranger_px3",
    dtcs: list[str] | None = None,
) -> dict[str, Any]:
    """The rules engine's make/model-aware answer to a technician's follow-up question."""
    platform = get_vehicle_platform(vehicle_profile)
    nodes = platform["shared_nodes"]

    q = question.lower()
    if "0v" in q or "0.0v" in q or "no voltage" in q or "open" in q:
        guidance = (
            f"On {platform['make']} {platform['model']}, 0.0V at "
            f"{nodes[0]} points to an open supply fuse/relay or broken "
            f"harness wire upstream. Check continuity back to "
            f"{nodes[-1]} before condemning the ECU."
        )
        next_step = (
            "Inspect main relay/fuse continuity and load-test the supply pin with a 21W test lamp."
        )
    elif "regen" in q or "dpf" in q or "bleed" in q or "reset" in q:
        guidance = (
            f"For {platform['make']} {platform['model']}, service "
            f"routines (DPF regen / ABS bleed / BMS reset) require "
            f"Tier A/B SafetyInterlock confirmation: vehicle stationary "
            f"(0 km/h), battery >= 12.5V, and 1.5s hold-to-confirm."
        )
        next_step = (
            "Open Service Functions, verify preconditions are green, "
            "and execute the gated UDS routine."
        )
    else:
        dtc_str = ", ".join(dtcs or ["active fault"])
        guidance = (
            f"For {platform['make']} {platform['model']} ({platform['engine']}) with {dtc_str}, "
            f"verify communication on {', '.join(platform['protocols'])} "
            f"and inspect {nodes[0]} and {nodes[-1]}."
        )
        next_step = (
            f"Check live PIDs on {platform['modules'][0]['id']} "
            f"({platform['modules'][0]['tx']}) and compare against KOEO spec."
        )

    return {
        "session_id": session_id,
        "vehicle": f"{platform['make']} {platform['model']}",
        "mode": "RULES",
        "analysis": ENGINE_RULES,
        "analysis_label": RULES_LABEL,
        "quota_charged": False,
        "cited_nodes": nodes[:2],
        "answer": guidance,
        "recommended_next_step": next_step,
    }


# --- language model ---------------------------------------------------------------

_SYSTEM = (
    "You are an automotive diagnostic assistant for qualified workshop technicians in "
    "Australia. Reason only from the evidence given: DTCs, the vehicle platform, its circuit "
    "nodes and the workshop's resolved cases. Never invent part numbers, case IDs, circuit "
    "nodes, security-access procedures, PINs or seed/key methods. Reply with a single JSON "
    "object and nothing else."
)


def _evidence(rules: dict[str, Any], dtcs: list[str], vehicle_profile: str) -> dict[str, Any]:
    platform = get_vehicle_platform(vehicle_profile)
    return {
        "vehicle": rules.get("vehicle"),
        "engine": platform.get("engine"),
        "protocols": platform.get("protocols"),
        "modules": [m.get("id") for m in platform.get("modules", [])],
        "dtcs": [d.upper() for d in dtcs],
        "platform_notes": {
            code: note
            for code, note in platform.get("common_dtcs", {}).items()
            if code in {d.upper() for d in dtcs}
        },
        "circuit_nodes": rules.get("shared_circuit_nodes", []),
        "resolved_cases": [
            {
                "case_id": str(c.get("case_id")),
                "dtcs": c.get("dtcs", []),
                "verified_fix": c.get("verified_fix"),
                "summary": c.get("symptom_summary") or c.get("canonical_summary"),
            }
            for c in rules.get("matched_cases", [])
            if c.get("case_id")
        ][:12],
        "rules_ranking": [
            {"dtc": r["dtc"], "band": r["confidence_band"], "hypothesis": r["hypothesis"]}
            for r in rules.get("ranked_causes", [])
        ],
    }


def llm_diagnosis(
    provider: LlmProvider,
    rules: dict[str, Any],
    dtcs: list[str],
    vehicle_profile: str,
) -> dict[str, Any]:
    """Ask the model to rank root causes from the evidence; checked before it's returned.

    Raises LlmError when the call fails or nothing valid comes back.
    """
    evidence = _evidence(rules, dtcs, vehicle_profile)
    prompt = (
        "Evidence:\n"
        + json.dumps(evidence, ensure_ascii=False)
        + '\n\nReturn JSON: {"summary": string (2-4 sentences for the technician), '
        '"ranked_causes": [{"dtc": one of evidence.dtcs, "confidence_band": "HIGH"|"MEDIUM"|'
        '"LOW", "hypothesis": string, "cited_nodes": [names from evidence.circuit_nodes], '
        '"cited_case_ids": [ids from evidence.resolved_cases], "multimeter_test": string}]}. '
        "Use HIGH only when a resolved case or platform note supports it."
    )
    raw = provider.complete_json(system=_SYSTEM, prompt=prompt)
    allowed_nodes = set(evidence["circuit_nodes"])
    allowed_cases = {c["case_id"] for c in evidence["resolved_cases"]}
    allowed_dtcs = set(evidence["dtcs"])
    steps = {r["dtc"]: r.get("guided_steps", []) for r in rules.get("ranked_causes", [])}
    ranked: list[dict[str, Any]] = []
    for item in raw.get("ranked_causes") or []:
        if not isinstance(item, dict):
            continue
        dtc = str(item.get("dtc", "")).upper()
        hypothesis = str(item.get("hypothesis") or "").strip()
        if dtc not in allowed_dtcs or not hypothesis:
            continue
        band = str(item.get("confidence_band", "")).upper()
        cases = [str(c) for c in item.get("cited_case_ids") or [] if str(c) in allowed_cases]
        if band not in BANDS or (
            band == "HIGH" and not cases and dtc not in evidence["platform_notes"]
        ):
            band = "MEDIUM" if band == "HIGH" else "LOW"
        ranked.append(
            {
                "dtc": dtc,
                "confidence_band": band,
                "cited_nodes": [
                    str(n) for n in item.get("cited_nodes") or [] if n in allowed_nodes
                ][:4],
                "cited_case_ids": cases,
                "hypothesis": hypothesis[:600],
                "multimeter_test": str(item.get("multimeter_test") or "").strip()[:400],
                "guided_steps": steps.get(dtc, []),
            }
        )
    if not ranked:
        raise LlmError("the model's answer had no usable causes")
    summary = str(raw.get("summary") or "").strip()[:1200] or None
    return {
        **rules,
        "mode": "LLM_SYNTHESIS",
        "analysis": ENGINE_LLM,
        "analysis_label": provider.label,
        "summary": summary,
        "ranked_causes": ranked,
    }


def llm_followup(
    provider: LlmProvider,
    rules_answer: dict[str, Any],
    question: str,
    vehicle_profile: str,
    dtcs: list[str],
) -> dict[str, Any]:
    platform = get_vehicle_platform(vehicle_profile)
    nodes = platform["shared_nodes"]
    evidence = {
        "vehicle": f"{platform['make']} {platform['model']}",
        "engine": platform.get("engine"),
        "dtcs": [d.upper() for d in dtcs],
        "circuit_nodes": nodes,
        "rules_answer": rules_answer.get("answer"),
    }
    prompt = (
        "Evidence:\n"
        + json.dumps(evidence, ensure_ascii=False)
        + "\n\nTechnician's question: "
        + question.strip()[:2000]
        + '\n\nReturn JSON: {"answer": string, "recommended_next_step": string, '
        '"cited_nodes": [names from evidence.circuit_nodes]}'
    )
    raw = provider.complete_json(system=_SYSTEM, prompt=prompt)
    answer = str(raw.get("answer") or "").strip()
    if not answer:
        raise LlmError("the model's answer was empty")
    return {
        **rules_answer,
        "mode": "LLM_COPILOT",
        "analysis": ENGINE_LLM,
        "analysis_label": provider.label,
        "answer": answer[:2000],
        "recommended_next_step": str(raw.get("recommended_next_step") or "").strip()[:600]
        or rules_answer.get("recommended_next_step"),
        "cited_nodes": [str(n) for n in raw.get("cited_nodes") or [] if n in set(nodes)][:4],
    }
