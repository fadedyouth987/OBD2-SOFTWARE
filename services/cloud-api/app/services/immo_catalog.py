"""Allow-listed immobilizer procedures. One sandbox OEM/ECU profile for now.

The Bluetooth dongle path may run only this on-board key-learn profile.
Real OEM procedures are added later, still without shipping seed/key algorithms.
"""

from __future__ import annotations

from dataclasses import dataclass

# 17-character VIN used by the sandbox simulator (no I, O, or Q).
SANDBOX_VIN = "SBXTESTVAN0000001"
SANDBOX_OEM = "SANDBOX"
SANDBOX_OPERATION = "add_key_onboard"
SANDBOX_DEVICE_TIER = "dongle"
SANDBOX_DEVICE_ID = "RC-DONGLE-SANDBOX"
SANDBOX_ECU_TX = 0x7E2
SANDBOX_ECU_RX = 0x7EA
# Well-known sandbox SecurityAccess key, issued only by the sandbox OEM
# adapter when AUTH_ALLOW_DEV_LOGIN is on. Not an OEM algorithm.
SANDBOX_KEY_HEX = "53424F584B455931"  # ASCII "SBOXKEY1"
SANDBOX_PROFILE_ID = "sandbox-immo"

IMMO_LEASE_DEFAULT_TTL_S = 15 * 60
IMMO_LEASE_MAX_TTL_S = 30 * 60
IMMO_MIN_BATTERY_V = 13.0
IMMO_LEASE_KIND = "immo_lease"
IMMO_FEATURE = "IMMO_PROGRAM"


@dataclass(frozen=True)
class ImmoProfile:
    oem: str
    operation: str
    device_tier: str
    ecu_tx: int
    ecu_rx: int
    profile_id: str


SANDBOX_PROFILE = ImmoProfile(
    oem=SANDBOX_OEM,
    operation=SANDBOX_OPERATION,
    device_tier=SANDBOX_DEVICE_TIER,
    ecu_tx=SANDBOX_ECU_TX,
    ecu_rx=SANDBOX_ECU_RX,
    profile_id=SANDBOX_PROFILE_ID,
)

ALLOW_LIST: tuple[ImmoProfile, ...] = (SANDBOX_PROFILE,)


def lookup_profile(oem: str, operation: str, device_tier: str) -> ImmoProfile | None:
    oem_n = (oem or "").strip().upper()
    op_n = (operation or "").strip().lower()
    tier_n = (device_tier or "").strip().lower()
    for profile in ALLOW_LIST:
        if profile.oem == oem_n and profile.operation == op_n and profile.device_tier == tier_n:
            return profile
    return None
