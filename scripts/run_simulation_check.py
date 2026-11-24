#!/usr/bin/env python3
"""End-to-end simulation & integration check for RootCause OBD (cloud-api, ai-worker, schemas)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("AWS_REGION", "ap-southeast-2")
os.environ["CLOUD_STATE_DIR"] = tempfile.mkdtemp(prefix="rc_sim_state_")

# 1. Test cloud-api end-to-end via FastAPI TestClient
sys.path.insert(0, str(ROOT / "services" / "cloud-api"))
from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

assert client.get("/healthz").json() == {"status": "ok", "region": "ap-southeast-2"}

jwks = client.get("/api/v1/auth/jwks").json()
assert len(jwks["keys"]) == 1 and jwks["keys"][0]["kid"] == "cloud-2026-11"

lease = client.post(
    "/api/v1/auth/edge-lease",
    json={"tenant_id": "t_au_01", "user_id": "u_tech_01", "tier": "WORKSHOP", "dongle_id": "RC-DONGLE-001"},
).json()
assert lease["kid"] == "cloud-2026-11" and lease["token"].count(".") == 2

sync1 = client.post(
    "/api/v1/sessions/sync",
    json={
        "batch_id": "batch-sim-001",
        "tenant_id": "t_au_01",
        "session_id": "sess-sim-001",
        "watermark_us": 1000,
        "telemetry_rows": [{"pid": 12, "value": 780}],
        "audit_entries": [{"action": "0x04", "status": "APPROVED"}],
    },
).json()
assert sync1["status"] == "accepted" and sync1["telemetry_ingested"] == 1

sync2 = client.post(
    "/api/v1/sessions/sync",
    json={
        "batch_id": "batch-sim-001",
        "tenant_id": "t_au_01",
        "session_id": "sess-sim-001",
        "watermark_us": 1000,
    },
).json()
assert sync2["status"] == "duplicate_ignored"
assert client.get("/api/v1/sessions/sess-sim-001").json()["watermark_us"] == 1000

pub = client.post(
    "/api/v1/cases/publish",
    json={
        "vin": "MPBUMFF60PX418290",
        "engine_family": "Ford 3.0L V6 PowerStroke",
        "dtcs": ["P2463"],
        "symptom_summary": "DPF soot warning under load",
        "verified_fix": "Replaced split DPF differential pressure hose",
        "parts_replaced": ["DPF Hose"],
    },
).json()
assert pub["status"] == "published"
assert "MPBUMFF60PX418290" not in json.dumps(pub)

diag_ok = client.post(
    "/api/v1/diagnose/sess-sim-001",
    json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3"},
).json()
assert diag_ok["mode"] == "KG_RAG_SYNTHESIS" and diag_ok["quota_charged"] is True
assert diag_ok["ranked_causes"][0]["confidence_band"] in {"HIGH", "MEDIUM", "LOW"}
assert pub["case"]["case_id"] in diag_ok["ranked_causes"][0]["cited_case_ids"]

diag_fb = client.post(
    "/api/v1/diagnose/sess-sim-001",
    json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3", "llm_error": "timeout"},
).json()
assert diag_fb["mode"] == "FALLBACK_NO_LLM" and diag_fb["quota_charged"] is False

payload = json.dumps({"id": "evt_sim_1", "type": "invoice.paid"}).encode("utf-8")
sig = hmac.new(b"whsec_dev_test", payload, hashlib.sha256).hexdigest()
wh = client.post("/api/v1/billing/stripe/webhook", data=payload, headers={"stripe-signature": sig}).json()
assert wh["status"] == "processed"

aasra = client.post(
    "/api/v1/gateways/aasra/verify",
    json={"workshop_abn": "12 345 678 901", "aasra_member_id": "AASRA-9921", "oem": "Ford"},
).json()
assert aasra["eligible"] is True

# 2. Test ai-worker schematic pipeline & local Neo4j topology simulation
for k in list(sys.modules): 
    if k == "app" or k.startswith("app."): del sys.modules[k]
sys.path.insert(0, str(ROOT / "services" / "ai-worker"))
from app.graph.neo4j_client import TenantScopedGraphRepository  # noqa: E402
from app.vision.schematic_pipeline import run_schematic_pipeline  # noqa: E402

repo = TenantScopedGraphRepository()
topo_res = repo.execute_shared_dependency_query("t_au_01", ["PCM", "BCM"], profile="ford_ranger_px3")
assert topo_res["source"] == "seed_topology_sim" and len(topo_res["rows"]) >= 3

sch = run_schematic_pipeline(
    size_bytes=4096,
    pages=["Fuse F04 feeds PCM via X101 on HS-CAN", "Ground G101 shared with DPF sensor"],
)
assert sch["node_count"] >= 4


veh = client.get("/api/v1/vehicles").json()
assert veh["oem_platform_count"] == 27
dec_byd = client.get("/api/v1/vehicles/decode/LC0C1234567890123").json()
assert dec_byd["matched"] is True and dec_byd["make"] == "BYD"
dec = client.get("/api/v1/vehicles/decode/MPBUMFF60PX418290").json()
assert dec["matched"] is True and dec["profile"] == "ford_ranger_px3"
dec_comm = client.get("/api/v1/vehicles/decode/6G1EP5E20CL600001").json()
assert dec_comm["matched"] is True and "Commodore" in dec_comm["model"]
assert len(diag_ok["ranked_causes"][0]["guided_steps"]) == 4
ask = client.post(
    "/api/v1/diagnose/sess-sim-001/ask",
    json={"question": "I measured 0.0V on pin 2", "vehicle_profile": "bmw_e90_dcan", "dtcs": ["2AAF"]},
).json()
assert ask["mode"] == "KG_RAG_COPILOT" and "BMW" in ask["vehicle"]


sgw = client.post(
    "/api/v1/gateways/sgw/unlock",
    json={"tenant_id": "t_au_01", "user_id": "u_tech", "vin": "1C4RJFBG1LC123456", "oem": "Jeep", "autoauth_account": "shop_au_01"},
).json()
import base64
_sgw_tok = sgw["sgw_session_lease"]["token"].split(".")[1]
_sgw_claims = json.loads(base64.urlsafe_b64decode(_sgw_tok + "=" * (-len(_sgw_tok) % 4)))
assert sgw["status"] == "unlocked" and "SGW_UNLOCK" in _sgw_claims["features"]


# 3. Verify Founding Customer Stripe Checkout -> Active Tier -> Ed25519 Signature & lease.rs Claim Parity
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
pub_bytes = bytes.fromhex(jwks["keys"][0]["raw_hex"])
pub_key = Ed25519PublicKey.from_public_bytes(pub_bytes)

checkout_payload = json.dumps({
    "id": "evt_founding_001",
    "type": "checkout.session.completed",
    "data": {"object": {"metadata": {"tenant_id": "t_au_founding_01", "tier": "WORKSHOP", "source": "kickstarter_founding"}}},
}).encode("utf-8")
checkout_sig = hmac.new(b"whsec_dev_test", checkout_payload, hashlib.sha256).hexdigest()
wh_res = client.post("/api/v1/billing/stripe/webhook", data=checkout_payload, headers={"stripe-signature": checkout_sig}).json()
assert wh_res["status"] == "processed" and wh_res["active_tier"] == "WORKSHOP"

founding_lease = client.post(
    "/api/v1/auth/edge-lease",
    json={"tenant_id": "t_au_founding_01", "user_id": "u_founder_01", "dongle_id": "RC-DONGLE-001", "aasra_verified": True},
).json()
h_b64, p_b64, sig_b64 = founding_lease["token"].split(".")
pub_key.verify(base64.urlsafe_b64decode(sig_b64 + "=" * (-len(sig_b64) % 4)), f"{h_b64}.{p_b64}".encode("ascii"))
claims = json.loads(base64.urlsafe_b64decode(p_b64 + "=" * (-len(p_b64) % 4)))
assert claims["aud"] == "edge-daemon"
assert claims["tenant_id"] == "t_au_founding_01"
assert claims["tier"] == "WORKSHOP"
assert claims["aasra_verified"] is True
assert "UDS_ACTIVE" in claims["features"] and "CAN_RE_PRO" in claims["features"] and "J2534" in claims["features"]
assert 0 < (claims["exp"] - claims["nbf"]) <= 72 * 3600

pairing = client.post(
    "/api/v1/auth/edge-pairing",
    json={"tenant_id": "t_au_founding_01", "user_id": "u_founder_01", "origin": "http://localhost:3000"},
).json()
ph, pp, ps = pairing["token"].split(".")
pub_key.verify(base64.urlsafe_b64decode(ps + "=" * (-len(ps) % 4)), f"{ph}.{pp}".encode("ascii"))
pclaims = json.loads(base64.urlsafe_b64decode(pp + "=" * (-len(pp) % 4)))
assert pclaims["aud"] == "edge-ws" and pclaims["tenant_id"] == "t_au_founding_01" and pclaims["user_id"] == "u_founder_01"
assert pclaims["origin"] == "http://localhost:3000" and 0 < (pclaims["exp"] - pclaims["nbf"]) <= 300

print("ALL SIMULATION CHECKS PASSED!")
