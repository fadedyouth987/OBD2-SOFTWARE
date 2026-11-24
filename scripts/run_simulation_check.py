#!/usr/bin/env python3
"""End-to-end simulation & integration check for RootCause OBD (cloud-api, ai-worker, schemas)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("AWS_REGION", "ap-southeast-2")

# Load local .env so a developer machine (and this box) can sign and persist.
env_path = ROOT / ".env"
if env_path.exists():
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())

os.environ["AUTH_ALLOW_DEV_LOGIN"] = "true"
if not os.environ.get("CLOUD_SIGNING_PRIVATE_KEY_HEX", "").strip():
    os.environ["CLOUD_SIGNING_PRIVATE_KEY_HEX"] = os.urandom(32).hex()
    print("WARNING: generated an ephemeral CLOUD_SIGNING_PRIVATE_KEY_HEX for this run", file=sys.stderr)
if not os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip():
    os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_sim_local_not_for_production"

WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

sys.path.insert(0, str(ROOT / "services" / "cloud-api"))
from fastapi.testclient import TestClient  # noqa: E402
from app.services.immo_catalog import (  # noqa: E402
    SANDBOX_DEVICE_ID,
    SANDBOX_KEY_HEX,
    SANDBOX_OEM,
    SANDBOX_OPERATION,
    SANDBOX_VIN,
)
from app.main import app  # noqa: E402

client = TestClient(app)


def stripe_header(payload: bytes, secret: str = WEBHOOK_SECRET) -> str:
    ts = int(time.time())
    signed = f"{ts}.".encode("utf-8") + payload
    sig = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={ts},v1={sig}"


def b64url_json(segment: str) -> dict:
    return json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))


assert client.get("/healthz").json() == {"status": "ok", "region": "ap-southeast-2"}

jwks = client.get("/api/v1/auth/jwks").json()
assert len(jwks["keys"]) == 1 and jwks["keys"][0]["kid"] == "cloud-2026-11"
assert "raw_hex" not in jwks["keys"][0]

# Unauthenticated attacker lease must fail.
attacker = client.post(
    "/api/v1/auth/edge-lease",
    json={"tenant_id": "t_attacker", "user_id": "u_attacker", "tier": "WORKSHOP", "aasra_verified": True},
)
assert attacker.status_code == 401

run_id = uuid.uuid4().hex[:10]
dev = client.post(
    "/api/v1/auth/dev-session",
    json={"email": f"sim-founder-{run_id}@localhost", "tenant_name": "Founding workshop"},
).json()
token = dev["access_token"]
tenant_id = dev["tenant_id"]
user_id = dev["user_id"]
auth = {"Authorization": f"Bearer {token}"}
session_id = f"sess-sim-{run_id}"
batch_id = f"batch-sim-{run_id}"

lease = client.post(
    "/api/v1/auth/edge-lease",
    json={"tenant_id": "t_attacker", "user_id": "u_tech_01", "tier": "WORKSHOP", "dongle_id": "RC-DONGLE-001"},
    headers=auth,
).json()
assert lease["kid"] == "cloud-2026-11" and lease["token"].count(".") == 2
# New tenants start on COMMUNITY until billing upgrades them.
assert lease["tier"] == "COMMUNITY" and lease["features"] == []

sync1 = client.post(
    "/api/v1/sessions/sync",
    json={
        "batch_id": batch_id,
        "tenant_id": "t_attacker",
        "session_id": session_id,
        "watermark_us": 1000,
        "telemetry_rows": [{"pid": 12, "value": 780, "name": "rpm"}],
        "audit_entries": [{"seq": 1, "action": "0x04", "status": "APPROVED"}],
    },
    headers=auth,
).json()
assert sync1["status"] == "accepted" and sync1["telemetry_ingested"] == 1

sync2 = client.post(
    "/api/v1/sessions/sync",
    json={
        "batch_id": batch_id,
        "tenant_id": "t_attacker",
        "session_id": session_id,
        "watermark_us": 1000,
    },
    headers=auth,
).json()
assert sync2["status"] == "duplicate_ignored"
assert client.get(f"/api/v1/sessions/{session_id}", headers=auth).json()["watermark_us"] == 1000

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
    headers=auth,
).json()
assert pub["status"] == "published"
assert "MPBUMFF60PX418290" not in json.dumps(pub)

diag_ok = client.post(
    f"/api/v1/diagnose/{session_id}",
    json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3"},
    headers=auth,
).json()
assert diag_ok["mode"] == "KG_RAG_SYNTHESIS" and diag_ok["quota_charged"] is True
assert diag_ok["ranked_causes"][0]["confidence_band"] in {"HIGH", "MEDIUM", "LOW"}
assert pub["case"]["case_id"] in diag_ok["ranked_causes"][0]["cited_case_ids"]

diag_fb = client.post(
    f"/api/v1/diagnose/{session_id}",
    json={"dtcs": ["P2463"], "vehicle_profile": "ford_ranger_px3", "llm_error": "timeout"},
    headers=auth,
).json()
assert diag_fb["mode"] == "FALLBACK_NO_LLM" and diag_fb["quota_charged"] is False

payload = json.dumps({
    "id": f"evt_sim_{run_id}",
    "type": "invoice.paid",
    "data": {"object": {"metadata": {"tenant_id": tenant_id, "tier": "WORKSHOP"}}},
}).encode("utf-8")
wh = client.post(
    "/api/v1/billing/stripe/webhook",
    content=payload,
    headers={"Stripe-Signature": stripe_header(payload), "Content-Type": "application/json"},
).json()
assert wh["status"] in {"processed", "duplicate_ignored"}

aasra = client.post(
    "/api/v1/gateways/aasra/verify",
    json={"workshop_abn": "12 345 678 901", "aasra_member_id": "AASRA-9921", "oem": "Ford", "vsp_authorized": True},
    headers=auth,
).json()
# Client flags are ignored; the tenant is unverified until marked.
assert aasra["eligible"] is False

# 2. Test ai-worker schematic pipeline & local Neo4j topology simulation
for k in list(sys.modules):
    if k == "app" or k.startswith("app."):
        del sys.modules[k]
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
dec_byd = client.post("/api/v1/vehicles/decode", json={"vin": "LC0C1234567890123"}, headers=auth).json()
assert dec_byd["matched"] is True and dec_byd["make"] == "BYD"
dec = client.post("/api/v1/vehicles/decode", json={"vin": "MPBUMFF60PX418290"}, headers=auth).json()
assert dec["matched"] is True and dec["profile"] == "ford_ranger_px3"
dec_comm = client.post("/api/v1/vehicles/decode", json={"vin": "6G1EP5E20CL600001"}, headers=auth).json()
assert dec_comm["matched"] is True and "Commodore" in dec_comm["model"]
assert len(diag_ok["ranked_causes"][0]["guided_steps"]) == 4
ask = client.post(
    f"/api/v1/diagnose/{session_id}/ask",
    json={"question": "I measured 0.0V on pin 2", "vehicle_profile": "bmw_e90_dcan", "dtcs": ["2AAF"]},
    headers=auth,
).json()
assert ask["mode"] == "KG_RAG_COPILOT" and "BMW" in ask["vehicle"]

# SGW stays closed until the tenant is marked via the dev-only trusted path.
sgw_denied = client.post(
    "/api/v1/gateways/sgw/unlock",
    json={"tenant_id": "t_au_01", "user_id": "u_tech", "vin": "1C4RJFBG1LC123456", "oem": "Jeep", "autoauth_account": "shop_au_01"},
    headers=auth,
)
assert sgw_denied.status_code == 403
assert "1C4RJFBG1LC123456" not in sgw_denied.text

marked = client.post("/api/v1/auth/dev-mark-aasra", headers=auth)
assert marked.status_code == 200
sgw = client.post(
    "/api/v1/gateways/sgw/unlock",
    json={"oem": "Jeep", "vin": "1C4RJFBG1LC123456", "autoauth_account": "shop_au_01"},
    headers=auth,
).json()
assert sgw["status"] == "unlocked"
assert "vin" not in sgw and "vin_last4" not in sgw
assert "SGW_UNLOCK" not in sgw["sgw_session_lease"]["features"]

# 3. Official Stripe signature, founding-tier upgrade, lease claim parity
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

pub_bytes = base64.urlsafe_b64decode(jwks["keys"][0]["x"] + "=" * (-len(jwks["keys"][0]["x"]) % 4))
pub_key = Ed25519PublicKey.from_public_bytes(pub_bytes)

checkout_payload = json.dumps({
    "id": f"evt_founding_{run_id}",
    "type": "checkout.session.completed",
    "data": {"object": {"metadata": {"tenant_id": tenant_id, "tier": "WORKSHOP", "source": "kickstarter_founding"}}},
}).encode("utf-8")
wh_res = client.post(
    "/api/v1/billing/stripe/webhook",
    content=checkout_payload,
    headers={"Stripe-Signature": stripe_header(checkout_payload), "Content-Type": "application/json"},
).json()
assert wh_res["status"] in {"processed", "duplicate_ignored"}
assert wh_res.get("active_tier") == "WORKSHOP"

founding_lease = client.post(
    "/api/v1/auth/edge-lease",
    json={"tenant_id": "t_attacker", "user_id": "u_founder_01", "dongle_id": "RC-DONGLE-001", "aasra_verified": False},
    headers=auth,
).json()
h_b64, p_b64, sig_b64 = founding_lease["token"].split(".")
pub_key.verify(base64.urlsafe_b64decode(sig_b64 + "=" * (-len(sig_b64) % 4)), f"{h_b64}.{p_b64}".encode("ascii"))
claims = b64url_json(p_b64)
assert claims["aud"] == "edge-daemon"
assert claims["tenant_id"] == tenant_id
assert claims["user_id"] == user_id
assert claims["tier"] == "WORKSHOP"
assert claims["aasra_verified"] is True
assert "UDS_ACTIVE" in claims["features"] and "CAN_RE_PRO" in claims["features"] and "J2534" in claims["features"]
assert "IMMO_PROGRAM" not in claims["features"]
assert 0 < (claims["exp"] - claims["nbf"]) <= 72 * 3600

pairing = client.post(
    "/api/v1/auth/edge-pairing",
    json={"tenant_id": "t_attacker", "user_id": "u_founder_01", "origin": "http://localhost:3000"},
    headers=auth,
).json()
ph, pp, ps = pairing["token"].split(".")
pub_key.verify(base64.urlsafe_b64decode(ps + "=" * (-len(ps) % 4)), f"{ph}.{pp}".encode("ascii"))
pclaims = b64url_json(pp)
assert pclaims["aud"] == "edge-ws" and pclaims["tenant_id"] == tenant_id and pclaims["user_id"] == user_id
assert pclaims["origin"] == "http://localhost:3000" and 0 < (pclaims["exp"] - pclaims["nbf"]) <= 300


# --- Immobilizer Phase 1 (feature flag + deny paths + sandbox happy path) ---
from datetime import date

os.environ["IMMO_FEATURE_ENABLED"] = "false"
denied_flag = client.post(
    "/api/v1/immo/technicians/enrol",
    json={"aasra_member_id": "VSP-SIM", "national_police_check_dated": date.today().isoformat(), "declared": True},
    headers=auth,
)
assert denied_flag.status_code == 403, denied_flag.text

unauth = client.post("/api/v1/immo/sessions", json={"vin": SANDBOX_VIN, "authorisation_id": str(uuid.uuid4()), "oem": SANDBOX_OEM, "operation": SANDBOX_OPERATION, "device_id": SANDBOX_DEVICE_ID, "device_tier": "dongle"})
assert unauth.status_code == 401

os.environ["IMMO_FEATURE_ENABLED"] = "true"
# Workshop not yet marked in this block? The founding tenant was marked earlier via /dev-mark-aasra after first use?
# Re-mark to be safe, then enrol.
marked = client.post("/api/v1/auth/dev-mark-aasra", headers=auth)
assert marked.status_code == 200, marked.text
enrol = client.post(
    "/api/v1/immo/technicians/enrol",
    json={"aasra_member_id": "VSP-SIM", "national_police_check_dated": date.today().isoformat(), "declared": True},
    headers=auth,
)
assert enrol.status_code == 200 and enrol.json()["accredited"] is True, enrol.text

authz = client.post("/api/v1/immo/owner-authorisations", json={"vin": SANDBOX_VIN}, headers=auth)
assert authz.status_code == 200, authz.text
job = client.post(
    "/api/v1/immo/sessions",
    json={
        "vin": SANDBOX_VIN,
        "authorisation_id": authz.json()["id"],
        "oem": SANDBOX_OEM,
        "operation": SANDBOX_OPERATION,
        "device_id": SANDBOX_DEVICE_ID,
        "device_tier": "dongle",
        "aasra_verified": False,  # ignored
    },
    headers=auth,
)
assert job.status_code == 200, job.text
ilease = job.json()["lease"]
assert ilease["lease_kind"] == "immo_lease" and ilease["features"] == ["IMMO_PROGRAM"]
assert "vin" not in ilease
ih, ip, isig = ilease["token"].split(".")
pub_key.verify(base64.urlsafe_b64decode(isig + "=" * (-len(isig) % 4)), f"{ih}.{ip}".encode("ascii"))
iclaims = b64url_json(ip)
assert iclaims["aud"] == "edge-daemon" and iclaims["lease_kind"] == "immo_lease"
assert iclaims["vin"] == SANDBOX_VIN and iclaims["device_id"] == SANDBOX_DEVICE_ID
assert 0 < (iclaims["exp"] - iclaims["nbf"]) <= 30 * 60

sid = job.json()["session_id"]
tok = client.post(f"/api/v1/immo/sessions/{sid}/token", headers=auth)
assert tok.status_code == 200 and tok.json()["payload_hex"] == SANDBOX_KEY_HEX, tok.text
done = client.post(f"/api/v1/immo/sessions/{sid}/complete", headers=auth)
assert done.status_code == 200 and done.json()["status"] == "completed"

# Second start on a new authorisation should work now that the first job completed.
authz2 = client.post("/api/v1/immo/owner-authorisations", json={"vin": SANDBOX_VIN}, headers=auth)
job2 = client.post(
    "/api/v1/immo/sessions",
    json={"vin": SANDBOX_VIN, "authorisation_id": authz2.json()["id"], "oem": "FORD", "operation": SANDBOX_OPERATION, "device_id": SANDBOX_DEVICE_ID, "device_tier": "dongle"},
    headers=auth,
)
assert job2.status_code == 403 and "allow-list" in job2.json()["detail"]

os.environ.pop("IMMO_FEATURE_ENABLED", None)

print("ALL SIMULATION CHECKS PASSED!")
