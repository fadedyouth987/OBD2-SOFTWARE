"""Seed electrical topologies for Australian fleet & benchmark vehicles (Task 3.1)."""
from __future__ import annotations

SEED_TOPOLOGIES = {
    "bmw_e90_dcan": {
        "modules": ["DME", "DSC", "EGS", "CAS", "KOMBI"],
        "shared_nodes": ["NODE:PT_CAN_500K", "NODE:KL15_FUSE_F04", "NODE:CHASSIS_GND_X165"],
    },
    "ford_ranger_px3": {
        "modules": ["PCM", "TCM", "ABS", "BCM", "IPC", "RCM"],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:MS_CAN_125K", "NODE:EXH_DPF_DIFF_PRESS", "NODE:BATT_MAIN_GND_G101"],
    },
    "ford_falcon_ba_au": {
        "modules": ["PCM", "BEM", "ABS", "IC"],
        "shared_nodes": ["NODE:J1850_PWM_BUS", "NODE:ACP_BODY_BUS"],
    },
}


def get_seed_topology(profile: str) -> dict:
    return SEED_TOPOLOGIES.get(profile, SEED_TOPOLOGIES["ford_ranger_px3"])
