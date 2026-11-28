"""Make/model/platform vehicle registry, AutoVIN decoder, and service functions catalog."""

from __future__ import annotations

from typing import Any

VEHICLE_PLATFORMS: dict[str, dict[str, Any]] = {
    "holden_commodore_ve_vf": {
        "make": "Holden",
        "model": "Commodore VE / VF (2006-2017)",
        "engine": "3.6L Alloytec/SIDI LFX & 6.0L/6.2L L77/LS3 V8",
        "family": "gm",
        "wmi_prefixes": ["6G1"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {
                "id": "ECM",
                "bus": "GMLAN HS-CAN 500k",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {
                "id": "TCM",
                "bus": "GMLAN HS-CAN 500k",
                "tx": "0x7E2",
                "rx": "0x7EA",
                "network": "HS_CAN",
            },
            {
                "id": "EBCM",
                "bus": "GMLAN HS-CAN 500k",
                "tx": "0x243",
                "rx": "0x643",
                "network": "HS_CAN",
            },
            {
                "id": "BCM",
                "bus": "GMLAN HS-CAN 500k (gateway to single-wire CAN)",
                "tx": "0x241",
                "rx": "0x641",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:GMLAN_HS_500K", "NODE:BATT_POS_X50A", "NODE:ENG_BLK_GND_G106"],
        "common_dtcs": {
            "P0017": "Alloytec/SIDI timing chain stretch — inspect cam/crank phase & oil pressure.",
            "P0300": "V8/V6 random misfire — inspect coil harness ground G106 & injector balance.",
        },
    },
    "holden_commodore_vz": {
        "make": "Holden",
        "model": "Commodore VZ (2004-2006)",
        "engine": "3.6L Alloytec LY7/LE0 & 5.7L/6.0L LS1/L76",
        "family": "gm",
        "wmi_prefixes": ["6G1"],
        "protocols": ["ISO15765_11_500", "J1850_VPW"],
        "modules": [
            {
                "id": "ECM",
                "bus": "CAN 500k / VPW (LS1)",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {"id": "TCM", "bus": "CAN 500k", "tx": "0x7E2", "rx": "0x7EA", "network": "HS_CAN"},
            {
                "id": "ABS",
                "bus": "K-line on most variants",
                "tx": "",
                "rx": "",
                "network": "KLINE",
                "note": "Address depends on variant; not confirmed.",
            },
        ],
        "shared_nodes": ["NODE:GMLAN_HS_500K", "NODE:PIM_IMMOBILIZER", "NODE:ENG_GND_G104"],
        "common_dtcs": {
            "P0341": "Camshaft sensor or early Alloytec timing chain wear.",
        },
    },
    "holden_commodore_vn_vy": {
        "make": "Holden",
        "model": "Commodore VN / VP / VR / VS / VT / VX / VY V6 (1988-2004)",
        "engine": "3.8L Buick / Ecotec L36 V6 (8192-baud ALDL)",
        "family": "gm",
        "wmi_prefixes": ["6H8"],
        "protocols": ["ALDL_8192"],
        "modules": [
            {
                "id": "ECM",
                "bus": "GM 8192-baud ALDL (Pin 9)",
                "tx": "",
                "rx": "",
                "network": "ALDL",
            },
        ],
        "shared_nodes": ["NODE:ALDL_PIN9_8192", "NODE:DFI_CAS_MODULE"],
        "common_dtcs": {
            "12": "System Pass (No RPM pulse)",
            "42": "Electronic Spark Timing (EST) bypass fault — check DFI module.",
        },
    },
    "holden_commodore_vt_vy_ls1": {
        "make": "Holden",
        "model": "Commodore VT II - VY LS1 V8 (1999-2004)",
        "engine": "5.7L LS1 Gen-III V8 (note: VN-VY V6 uses 8192-baud ALDL)",
        "family": "gm",
        "wmi_prefixes": ["6H8", "6G1"],
        "protocols": ["J1850_VPW"],
        "modules": [
            {"id": "PCM", "bus": "J1850 VPW", "tx": "", "rx": "", "network": "J1850_VPW"},
        ],
        "shared_nodes": ["NODE:J1850_VPW_BUS", "NODE:PCM_MAIN_GND"],
        "common_dtcs": {
            "P0171": "Intake manifold / PCV vacuum leak on LS1.",
        },
    },
    "holden_commodore_zb": {
        "make": "Holden",
        "model": "Commodore ZB (2018-2020)",
        "engine": "2.0L LTG Turbo / 3.6L LGX V6",
        "family": "gm",
        "wmi_prefixes": ["W0V"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E2", "rx": "0x7EA", "network": "HS_CAN"},
            {"id": "EBCM", "bus": "HS-CAN 500k", "tx": "0x243", "rx": "0x643", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:BATT_SENSOR_LIN"],
        "common_dtcs": {
            "P0299": "2.0T wastegate actuator or charge pipe leak.",
        },
    },
    "holden_colorado_rg": {
        "make": "Holden / GM",
        "model": "Colorado RG & Trailblazer (2012-2020)",
        "engine": "2.8L Duramax LWN Diesel",
        "family": "gm",
        "wmi_prefixes": ["MMM"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E2", "rx": "0x7EA", "network": "HS_CAN"},
            {"id": "EBCM", "bus": "HS-CAN 500k", "tx": "0x243", "rx": "0x643", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:GMLAN_HS_500K", "NODE:BOOST_PIPE_MAP"],
        "common_dtcs": {
            "P0299": "Split intercooler hose or VGT turbo actuator.",
        },
    },
    "ford_falcon_ba_au": {
        "make": "Ford Australia",
        "model": "Falcon AU / BA / BF (1998-2008)",
        "engine": "4.0L Intech / Barra 182-190 I6",
        "family": "ford",
        "wmi_prefixes": ["6FP"],
        "protocols": ["J1850_PWM", "ISO15765_11_500"],
        "modules": [
            {
                "id": "PCM",
                "bus": "J1850 PWM / HS-CAN",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
                "note": "AU-era PCMs use J1850 PWM; BA/BF use CAN.",
            },
            {"id": "BEM", "bus": "ACP Body Bus", "tx": "", "rx": "", "network": "ACP"},
            {"id": "ABS", "bus": "J1850 PWM", "tx": "", "rx": "", "network": "J1850_PWM"},
            {"id": "IC", "bus": "ACP / J1850", "tx": "", "rx": "", "network": "ACP"},
        ],
        "shared_nodes": ["NODE:J1850_PWM_BUS", "NODE:ACP_BODY_BUS", "NODE:PCM_MAIN_RELAY_R1"],
        "common_dtcs": {
            "P0420": (
                "Catalyst Efficiency Below Threshold — check O2 heater fuse & exhaust "
                "manifold leaks."
            ),
        },
    },
    "ford_falcon_fg_fgx": {
        "make": "Ford Australia",
        "model": "Falcon FG / FGX & Territory SZ (2008-2016)",
        "engine": "4.0L Barra 195 / XR6 Turbo 270T / Miami 5.0L",
        "family": "ford",
        "wmi_prefixes": ["6FP"],
        "protocols": ["ISO15765_11_500", "MS_CAN_125"],
        "modules": [
            {"id": "PCM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {
                "id": "TCM",
                "bus": "HS-CAN 500k (ZF6HP26)",
                "tx": "0x7E1",
                "rx": "0x7E9",
                "network": "HS_CAN",
            },
            {"id": "ABS", "bus": "HS-CAN 500k", "tx": "0x760", "rx": "0x768", "network": "HS_CAN"},
            {
                "id": "BEM",
                "bus": "MS-CAN 125k (STP 53)",
                "tx": "0x726",
                "rx": "0x72E",
                "network": "MS_CAN",
                "note": (
                    "The ICC (Interior Command Centre) is a separate module; address not confirmed."
                ),
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:MS_CAN_125K", "NODE:ZF_MECHATRONIC_PLUG"],
        "common_dtcs": {
            "U0101": (
                "ZF6HP26 TCM comms/mechatronic sleeve leak — inspect 16-pin plug & bridge seal."
            ),
        },
    },
    "ford_ranger_px_px2": {
        "make": "Ford",
        "model": "Ranger PX / PX2 & Everest UA (2011-2018)",
        "engine": "2.0L Bi-Turbo / 3.2L Duratorq TDCi",
        "family": "ford",
        "wmi_prefixes": ["MPB", "MNA"],
        "years": [2011, 2018],
        "protocols": ["ISO15765_11_500", "MS_CAN_125"],
        "modules": [
            {"id": "PCM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {"id": "ABS", "bus": "HS-CAN 500k", "tx": "0x760", "rx": "0x768", "network": "HS_CAN"},
            {
                "id": "BCM",
                "bus": "MS-CAN 125k (STP 53)",
                "tx": "0x726",
                "rx": "0x72E",
                "network": "MS_CAN",
                "note": "Network not confirmed for PX/PX2.",
            },
            {
                "id": "IPC",
                "bus": "MS-CAN 125k (STP 53)",
                "tx": "0x720",
                "rx": "0x728",
                "network": "MS_CAN",
                "note": "Network not confirmed for PX/PX2.",
            },
            {
                "id": "RCM",
                "bus": "MS-CAN 125k (STP 53)",
                "tx": "0x737",
                "rx": "0x73F",
                "network": "MS_CAN",
                "note": "Network not confirmed for PX/PX2.",
            },
        ],
        "shared_nodes": [
            "NODE:HS_CAN_500K",
            "NODE:MS_CAN_125K",
            "NODE:EXH_DPF_DIFF_PRESS",
            "NODE:BATT_MAIN_GND_G101",
        ],
        "common_dtcs": {
            "P2463": (
                "DPF Soot Accumulation — check differential pressure hoses & 5V ref "
                "before forced regen."
            ),
        },
    },
    "ford_ranger_px3": {
        "make": "Ford",
        "model": "Ranger PX3 & Everest UA II (2018-2022)",
        "engine": "2.0L Bi-Turbo / 3.2L Duratorq TDCi",
        "family": "ford",
        "wmi_prefixes": ["MPB", "MNA"],
        "years": [2018, 2022],
        "protocols": ["ISO15765_11_500", "MS_CAN_125"],
        "modules": [
            {
                "id": "PCM",
                "bus": "HS-CAN1 (DIAG 1)",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {
                "id": "BCM",
                "bus": "HS-CAN1 (DIAG 1)",
                "tx": "0x726",
                "rx": "0x72E",
                "network": "HS_CAN",
            },
            {
                "id": "PAM",
                "bus": "HS-CAN1 (in BCM)",
                "tx": "0x736",
                "rx": "0x73E",
                "network": "HS_CAN",
            },
            {
                "id": "GWM",
                "bus": "HS-CAN1 (DIAG 1)",
                "tx": "0x716",
                "rx": "0x71E",
                "network": "HS_CAN",
            },
            {
                "id": "BECMB",
                "bus": "HS-CAN1 (DIAG 1)",
                "tx": "0x723",
                "rx": "0x72B",
                "network": "HS_CAN",
            },
            {
                "id": "DCDC",
                "bus": "HS-CAN1 (DIAG 1)",
                "tx": "0x746",
                "rx": "0x74E",
                "network": "HS_CAN",
            },
            {
                "id": "IPC",
                "bus": "HS-CAN3 via gateway",
                "tx": "0x720",
                "rx": "0x728",
                "network": "HS_CAN",
            },
            {
                "id": "APIM",
                "bus": "HS-CAN1/3/4 via gateway",
                "tx": "0x7D0",
                "rx": "0x7D8",
                "network": "HS_CAN",
            },
            {
                "id": "ACM",
                "bus": "HS-CAN3 via gateway",
                "tx": "0x727",
                "rx": "0x72F",
                "network": "HS_CAN",
            },
            {
                "id": "DSP",
                "bus": "HS-CAN3 via gateway",
                "tx": "0x783",
                "rx": "0x78B",
                "network": "HS_CAN",
            },
            {
                "id": "TCU",
                "bus": "HS-CAN4 via gateway",
                "tx": "0x754",
                "rx": "0x75C",
                "network": "HS_CAN",
            },
            {
                "id": "FCIM",
                "bus": "MS-CAN via gateway",
                "tx": "0x7A7",
                "rx": "0x7AF",
                "network": "HS_CAN",
            },
            {
                "id": "RTM",
                "bus": "MS-CAN via gateway",
                "tx": "0x751",
                "rx": "0x759",
                "network": "HS_CAN",
            },
            {
                "id": "SODL",
                "bus": "MS-CAN via gateway",
                "tx": "0x7C4",
                "rx": "0x7CC",
                "network": "HS_CAN",
            },
            {
                "id": "SODR",
                "bus": "MS-CAN via gateway",
                "tx": "0x7C6",
                "rx": "0x7CE",
                "network": "HS_CAN",
            },
            {
                "id": "TRM",
                "bus": "MS-CAN via gateway",
                "tx": "0x791",
                "rx": "0x799",
                "network": "HS_CAN",
            },
            {
                "id": "ABS",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x760",
                "rx": "0x768",
                "network": "HS_CAN2",
            },
            {
                "id": "RCM",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x737",
                "rx": "0x73F",
                "network": "HS_CAN2",
            },
            {
                "id": "PSCM",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x730",
                "rx": "0x738",
                "network": "HS_CAN2",
            },
            {
                "id": "SCCM",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x724",
                "rx": "0x72C",
                "network": "HS_CAN2",
            },
            {
                "id": "IPMA",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x706",
                "rx": "0x70E",
                "network": "HS_CAN2",
            },
            {
                "id": "OCSM",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x765",
                "rx": "0x76D",
                "network": "HS_CAN2",
            },
            {
                "id": "HUD",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x7B2",
                "rx": "0x7BA",
                "network": "HS_CAN2",
            },
            {
                "id": "ATCM",
                "bus": "HS-CAN2 (DIAG 2)",
                "tx": "0x792",
                "rx": "0x79A",
                "network": "HS_CAN2",
            },
            {
                "id": "CCM",
                "bus": "Adaptive cruise radar",
                "tx": "0x764",
                "rx": "0x76C",
                "network": "HS_CAN2",
                "note": "Network not listed in the manual's table.",
            },
        ],
        "shared_nodes": [
            "NODE:HS_CAN_500K",
            "NODE:MS_CAN_125K",
            "NODE:EXH_DPF_DIFF_PRESS",
            "NODE:BATT_MAIN_GND_G101",
        ],
        "common_dtcs": {
            "P2463": (
                "DPF Soot Accumulation — check differential pressure hoses & 5V ref "
                "before forced regen."
            ),
        },
    },
    "ford_ranger_next_gen": {
        "make": "Ford",
        "model": "Ranger & Everest next generation (2022-)",
        "engine": "2.0L Bi-Turbo / 3.0L V6 Diesel / 2.3L EcoBoost",
        "family": "ford",
        "wmi_prefixes": ["MPB", "MNA"],
        "years": [2022, 2030],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "PCM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:HS_CAN_500K"],
        "common_dtcs": {},
    },
    "bmw_e90_dcan": {
        "make": "BMW",
        "model": "1/3/5 Series E8x/E9x/E6x/E7x (2006-2013)",
        "engine": "N52 / N54 / N55 / N47",
        "family": "bmw",
        "wmi_prefixes": ["WBA", "WBS", "WBX"],
        "protocols": ["BMW_DCAN", "ISO15765_11_500"],
        "modules": [
            {
                "id": "DME",
                "bus": "PT-CAN / D-CAN (0x6F1->0x12)",
                "tx": "0x6F1",
                "rx": "0x612",
                "network": "HS_CAN",
            },
            {
                "id": "EGS",
                "bus": "PT-CAN / D-CAN (0x6F1->0x18)",
                "tx": "0x6F1",
                "rx": "0x618",
                "network": "HS_CAN",
            },
            {
                "id": "DSC",
                "bus": "PT-CAN / D-CAN (0x6F1->0x29)",
                "tx": "0x6F1",
                "rx": "0x629",
                "network": "HS_CAN",
            },
            {
                "id": "CAS",
                "bus": "K-CAN / D-CAN (0x6F1->0x00)",
                "tx": "0x6F1",
                "rx": "0x640",
                "network": "HS_CAN",
            },
            {
                "id": "KOMBI",
                "bus": "K-CAN / D-CAN (0x6F1->0x60)",
                "tx": "0x6F1",
                "rx": "0x660",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:PT_CAN_500K", "NODE:KL15_FUSE_F04", "NODE:CHASSIS_GND_X165"],
        "common_dtcs": {
            "2AAF": (
                "Fuel Pump Plausibility — test EKPS module supply voltage & low-pressure sensor."
            ),
        },
    },
    "toyota_hilux_gun126": {
        "make": "Toyota",
        "model": "Hilux / Fortuner / Prado / LandCruiser (2008-2024)",
        "engine": "2.8L 1GD-FTV / 3.0L 1KD-FTV / 4.5L 1VD-FTV",
        "family": "toyota",
        "wmi_prefixes": ["MR0", "JTE", "JTM"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {
                "id": "ABS/VSC",
                "bus": "HS-CAN 500k",
                "tx": "0x7B0",
                "rx": "0x7B8",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:EFI_MAIN_RELAY", "NODE:INJ_EDU_GND_E1"],
        "common_dtcs": {
            "P2002": (
                "DPF Efficiency Below Threshold — inspect 5th injector & differential "
                "pressure pipe."
            ),
        },
    },
    "toyota_jdm_hybrid_import": {
        "make": "Toyota / Lexus (JDM Import)",
        "model": "Prius / Crown / Alphard / Vellfire / Estima Hybrid",
        "engine": "2ZR-FXE / 2AR-FXE Hybrid Synergy Drive",
        "family": "toyota",
        "wmi_prefixes": ["JTD", "JTH"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {
                "id": "HV Control",
                "bus": "HS-CAN 500k",
                "tx": "0x7E2",
                "rx": "0x7EA",
                "network": "HS_CAN",
            },
            {
                "id": "Battery ECU",
                "bus": "HS-CAN 500k",
                "tx": "0x7E3",
                "rx": "0x7EB",
                "network": "HS_CAN",
            },
            {
                "id": "ABS/Regen",
                "bus": "HS-CAN 500k",
                "tx": "0x7B0",
                "rx": "0x7B8",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:HV_INTERLOCK_SW", "NODE:INV_COOLANT_PUMP"],
        "common_dtcs": {
            "P0A80": (
                "Replace Hybrid Battery Pack — inspect HV blower fan & delta-V across cell blocks."
            ),
        },
    },
    "mazda_cx5_mazda3": {
        "make": "Mazda",
        "model": "CX-5 / CX-3 / Mazda3 / Mazda6 (2012-2024)",
        "engine": "Skyactiv-D 2.2L / Skyactiv-G 2.0L & 2.5L",
        "family": "mazda",
        "wmi_prefixes": ["JM0", "JMZ"],
        "protocols": ["ISO15765_11_500", "MS_CAN_125"],
        "modules": [
            {"id": "PCM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {"id": "ABS", "bus": "HS-CAN 500k", "tx": "0x760", "rx": "0x768", "network": "HS_CAN"},
            {"id": "EPS", "bus": "HS-CAN 500k", "tx": "0x730", "rx": "0x738", "network": "HS_CAN"},
            {"id": "FSC", "bus": "HS-CAN 500k", "tx": "0x706", "rx": "0x70E", "network": "HS_CAN"},
            {
                "id": "SBS/MRCC",
                "bus": "HS-CAN 500k",
                "tx": "0x764",
                "rx": "0x76C",
                "network": "HS_CAN",
            },
            {
                "id": "BCM",
                "bus": "MS-CAN 125k",
                "tx": "0x726",
                "rx": "0x72E",
                "network": "MS_CAN",
                "note": "Network not confirmed.",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:MS_CAN_125K", "NODE:EXH_PRESS_SENSOR_1"],
        "common_dtcs": {
            "P0471": (
                "Exhaust Pressure Sensor Range/Performance — check carbon blockage in sensor pipe."
            ),
        },
    },
    "mazda_bt50_up_ur": {
        "make": "Mazda",
        "model": "BT-50 UP / UR (2011-2020, Ford Ranger PX twin)",
        "engine": "3.2L / 2.2L Duratorq TDCi",
        "family": "ford",
        "wmi_prefixes": ["MM7"],
        "years": [2011, 2020],
        "protocols": ["ISO15765_11_500", "MS_CAN_125"],
        "modules": [
            {"id": "PCM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {"id": "ABS", "bus": "HS-CAN 500k", "tx": "0x760", "rx": "0x768", "network": "HS_CAN"},
            {
                "id": "BCM",
                "bus": "MS-CAN 125k",
                "tx": "0x726",
                "rx": "0x72E",
                "network": "MS_CAN",
                "note": "Network not confirmed.",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:MS_CAN_125K", "NODE:EXH_DPF_DIFF_PRESS"],
        "common_dtcs": {
            "P2463": (
                "DPF Soot Accumulation — check differential pressure hoses & 5V ref "
                "before forced regen."
            ),
        },
    },
    "mazda_bt50_tf": {
        "make": "Mazda",
        "model": "BT-50 TF (2020-, Isuzu D-Max twin)",
        "engine": "3.0L 4JJ3-TCX Diesel",
        "family": "generic",
        "wmi_prefixes": [],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {
                "id": "ABS",
                "bus": "HS-CAN 500k",
                "tx": "0x760",
                "rx": "0x768",
                "network": "HS_CAN",
                "note": "Copied from D-Max; not confirmed.",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K"],
        "common_dtcs": {},
    },
    "hyundai_kia_platform": {
        "make": "Hyundai / Kia",
        "model": "i30 / Tucson / Sportage / Carnival / Stinger (2012-2024)",
        "engine": "2.0L GDi / 2.2L CRDi R-Engine",
        "family": "hyundai_kia",
        "wmi_prefixes": ["KMH", "KNA", "KND", "TMA"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "C-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCU", "bus": "C-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {
                "id": "ABS/ESP",
                "bus": "C-CAN 500k",
                "tx": "0x7D1",
                "rx": "0x7D9",
                "network": "HS_CAN",
            },
            {"id": "BCM", "bus": "B-CAN", "tx": "0x7A0", "rx": "0x7A8", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:C_CAN_500K", "NODE:JUNCTION_BOX_F12", "NODE:CHASSIS_GND_G11"],
        "common_dtcs": {
            "P0014": (
                "Exhaust Camshaft Timing Over-Advanced — test OCV solenoid resistance "
                "(6.9-7.9 ohm)."
            ),
        },
    },
    "vw_audi_mqb": {
        "make": "Volkswagen / Audi / Skoda",
        "model": "Golf / Amarok / Tiguan / A4 (2010-2024)",
        "engine": "EA888 2.0 TSI / EA288 2.0 TDI / V6 TDI",
        "family": "vag",
        "wmi_prefixes": ["WVW", "WAU", "WV1", "TMB"],
        "protocols": ["ISO15765_11_500", "ISO15765_29_500"],
        "modules": [
            {
                "id": "01-Engine",
                "bus": "Powertrain CAN 500k",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {
                "id": "02-Trans",
                "bus": "Powertrain CAN 500k",
                "tx": "0x7E1",
                "rx": "0x7E9",
                "network": "HS_CAN",
            },
            {
                "id": "03-ABS",
                "bus": "Powertrain CAN 500k",
                "tx": "0x713",
                "rx": "0x77D",
                "network": "HS_CAN",
            },
            {
                "id": "19-Gateway",
                "bus": "CAN Gateway",
                "tx": "0x710",
                "rx": "0x77A",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:PT_CAN_500K", "NODE:TERM15_RELAY_J329", "NODE:GATEWAY_J533"],
        "common_dtcs": {
            "P0299": (
                "Turbocharger Underboost — smoke-test charge pipes & verify N75 "
                "actuator duty cycle."
            ),
        },
    },
    "mercedes_sprinter_cclass": {
        "make": "Mercedes-Benz",
        "model": "C-Class W204/W205 & Sprinter NCV3/VS30",
        "engine": "OM651 2.1L / OM642 3.0L V6 Diesel / M274",
        "family": "generic",
        "wmi_prefixes": ["WDD", "WDB", "WDF", "W1K"],
        "protocols": ["ISO15765_11_500", "ISO15765_29_500"],
        "modules": [
            {
                "id": "CDI/ME",
                "bus": "Powertrain CAN 500k",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {
                "id": "EGS/VGS",
                "bus": "Powertrain CAN 500k",
                "tx": "0x7E1",
                "rx": "0x7E9",
                "network": "HS_CAN",
            },
            {
                "id": "ESP",
                "bus": "Chassis CAN 500k",
                "tx": "0x720",
                "rx": "0x728",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:PT_CAN_500K", "NODE:FRONT_SAM_N10", "NODE:DPF_BACKPRESS_B60"],
        "common_dtcs": {
            "P2453": "DPF Differential Pressure Sensor — inspect B28/8 sensor & boost hoses.",
        },
    },
    "isuzu_dmax_mux": {
        "make": "Isuzu",
        "model": "D-Max / MU-X (2012-2024)",
        "engine": "4JJ1-TC / 4JJ3-TCX 3.0L Diesel",
        "family": "generic",
        "wmi_prefixes": ["MP1"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {"id": "ABS", "bus": "HS-CAN 500k", "tx": "0x760", "rx": "0x768", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:SCV_SUCTION_VALVE", "NODE:ECM_GND_E2"],
        "common_dtcs": {
            "P0087": (
                "Fuel Rail Pressure Too Low — test Suction Control Valve (SCV) & fuel "
                "filter vacuum."
            ),
        },
    },
    "mitsubishi_triton_pajero": {
        "make": "Mitsubishi",
        "model": "Triton MQ/MR, Pajero Sport & Delica D:5 (2010-2024)",
        "engine": "4N15 2.4L / 4M41 3.2L Diesel",
        "family": "generic",
        "wmi_prefixes": ["MMA", "JMY"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {
                "id": "MPI/Diesel",
                "bus": "HS-CAN 500k",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {"id": "AT", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {
                "id": "ABS/ASC",
                "bus": "HS-CAN 500k",
                "tx": "0x784",
                "rx": "0x78C",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:INTERCOOLER_HOSE", "NODE:EGR_VALVE_LIN"],
        "common_dtcs": {
            "P0299": "Turbo Underboost — inspect split rubber intercooler hose on driver side.",
        },
    },
    "nissan_navara_patrol": {
        "make": "Nissan",
        "model": "Navara NP300, Patrol Y62 & Skyline/Elgrand JDM",
        "engine": "YS23DDTT 2.3L / VK56VD 5.6L V8 / VQ35",
        "family": "nissan",
        "wmi_prefixes": ["MNT", "JN1"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {"id": "ABS", "bus": "HS-CAN 500k", "tx": "0x740", "rx": "0x748", "network": "HS_CAN"},
            {"id": "IPDM", "bus": "HS-CAN 500k", "tx": "0x745", "rx": "0x74D", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:IPDM_ER_FUSE_BOX", "NODE:VAC_SOLENOID_BOOST"],
        "common_dtcs": {
            "P0101": "MAF Sensor Circuit Range — clean MAF & inspect turbo boost vacuum solenoid.",
        },
    },
    "subaru_forester_wrx": {
        "make": "Subaru",
        "model": "Forester / Outback / WRX / Levorg (2010-2024)",
        "engine": "FB25 / FA20DIT / FA24 / EJ25 Boxer",
        "family": "subaru",
        "wmi_prefixes": ["JF1", "JF2"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {
                "id": "VDC/ABS",
                "bus": "HS-CAN 500k",
                "tx": "0x7B0",
                "rx": "0x7B8",
                "network": "HS_CAN",
            },
            {
                "id": "EYESIGHT",
                "bus": "HS-CAN 500k",
                "tx": "0x787",
                "rx": "0x78F",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:STOP_LAMP_SW", "NODE:TGV_ACTUATOR"],
        "common_dtcs": {
            "P0171": "System Too Lean Bank 1 — inspect PCV hose & intake manifold gasket.",
        },
    },
    "honda_civic_crv_jdm": {
        "make": "Honda",
        "model": "Civic / CR-V / Accord / Fit JDM (2008-2024)",
        "engine": "K20 / K24 / L15B7 EarthDreams Turbo",
        "family": "honda",
        "wmi_prefixes": ["JHM", "MRH", "1HG"],
        "protocols": ["ISO15765_11_500", "ISO15765_29_500"],
        "modules": [
            {
                "id": "PGM-FI",
                "bus": "HS-CAN 500k (OBD)",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {
                "id": "AT/CVT",
                "bus": "HS-CAN 29-bit",
                "tx": "0x18DA1EF1",
                "rx": "0x18DAF11E",
                "network": "HS_CAN",
            },
            {
                "id": "VSA/ABS",
                "bus": "HS-CAN 29-bit",
                "tx": "0x18DA28F1",
                "rx": "0x18DAF128",
                "network": "HS_CAN",
            },
            {
                "id": "EPS",
                "bus": "HS-CAN 29-bit",
                "tx": "0x18DA30F1",
                "rx": "0x18DAF130",
                "network": "HS_CAN",
            },
            {
                "id": "SRS",
                "bus": "HS-CAN 29-bit",
                "tx": "0x18DA53F1",
                "rx": "0x18DAF153",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:PGMFI_MAIN_RELAY"],
        "common_dtcs": {
            "P0300": "L15B7 injector/coil misfire — check fuel dilution & coil pack resistance.",
        },
    },
    "suzuki_swift_jimny": {
        "make": "Suzuki",
        "model": "Swift / Jimny JB74 / Vitara (2012-2024)",
        "engine": "K15B 1.5L / K14C Boosterjet",
        "family": "generic",
        "wmi_prefixes": ["JS2", "JSA"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {
                "id": "ABS/ESP",
                "bus": "HS-CAN 500k",
                "tx": "0x760",
                "rx": "0x768",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:MAIN_FUSE_BOX"],
        "common_dtcs": {
            "P0420": "Catalyst Efficiency — check downstream O2 sensor & exhaust flange.",
        },
    },
    "gwm_haval_chery": {
        "make": "GWM / Haval / Chery",
        "model": "Cannon, Tank 300/500, Haval H6/Jolion & Chery Omoda 5 (2020-2026)",
        "engine": "2.0T / 2.4T Diesel / 1.5T DHT Hybrid & PHEV",
        "family": "generic",
        "wmi_prefixes": ["LGW", "LVV"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {"id": "ECM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {
                "id": "EPS/ESC",
                "bus": "HS-CAN 500k",
                "tx": "0x730",
                "rx": "0x738",
                "network": "HS_CAN",
            },
            {
                "id": "BCM/TPMS",
                "bus": "Body CAN",
                "tx": "0x740",
                "rx": "0x748",
                "network": "HS_CAN",
            },
            {
                "id": "RADAR/ADAS",
                "bus": "ADAS CAN",
                "tx": "0x750",
                "rx": "0x758",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:SAS_STEERING_ZERO", "NODE:AUX_12V_PHEV"],
        "common_dtcs": {
            "C1200": (
                "ESP/SAS uncalibrated — run SAS Zero-Point Calibration with wheels straight ahead."
            ),
            "U0100": (
                "PHEV/Hybrid 12V aux drop — load-test 12V battery before condemning HV modules."
            ),
        },
    },
    "byd_ev_phev": {
        "make": "BYD",
        "model": "Atto 3, Seal, Dolphin, Sealion 6/7 & Shark 6 (2022-2026)",
        "engine": "8-in-1 PMSM EV / DM-i PHEV Blade Battery",
        "family": "generic",
        "wmi_prefixes": ["LC0", "LGX"],
        "protocols": ["ISO15765_11_500", "ISO15765_29_500"],
        "modules": [
            {
                "id": "VCU",
                "bus": "Powertrain CAN 500k",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {"id": "BMS", "bus": "EV CAN 500k", "tx": "0x7E4", "rx": "0x7EC", "network": "HS_CAN"},
            {
                "id": "MCU/Inverter",
                "bus": "EV CAN 500k",
                "tx": "0x7E2",
                "rx": "0x7EA",
                "network": "HS_CAN",
            },
            {
                "id": "IPB (iBoost)",
                "bus": "Chassis CAN 500k",
                "tx": "0x7B0",
                "rx": "0x7B8",
                "network": "HS_CAN",
            },
        ],
        "shared_nodes": [
            "NODE:AUX_12V_DCDC_13V5",
            "NODE:REAR_AXLE_HV_CONN",
            "NODE:HV_ISOLATION_LOOP",
        ],
        "common_dtcs": {
            "VCU_LIMP_MODE": (
                "Check 12V aux voltage & DC-DC (>13.5V Ready); inspect rear-axle HV "
                "connector on Seal."
            ),
            "BMS_ISO_LOW": (
                "HV isolation resistance low — inspect underbody HV harness & coolant conductivity."
            ),
        },
    },
    "ldv_mg_saic": {
        "make": "LDV / MG (SAIC)",
        "model": "LDV T60 / G10 / D90 & MG ZS / HS / MG4 (2017-2026)",
        "engine": "2.0L Bi-Turbo Diesel / 1.5T Petrol / EV",
        "family": "saic",
        "wmi_prefixes": ["LSF", "LSJ"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {
                "id": "ECM/VCU",
                "bus": "HS-CAN 500k",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {
                "id": "ABS/ESP",
                "bus": "HS-CAN 500k",
                "tx": "0x760",
                "rx": "0x768",
                "network": "HS_CAN",
            },
            {"id": "BCM", "bus": "Body CAN", "tx": "0x740", "rx": "0x748", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:DPF_DIFF_PRESS", "NODE:INTERCOOLER_HOSE"],
        "common_dtcs": {
            "P2463": (
                "LDV T60 DPF soot load — inspect diff-pressure hoses & run Tier B forced regen."
            ),
            "P0299": "Turbo underboost — inspect charge pipe clamps & VGT actuator.",
        },
    },
    "landrover_jaguar": {
        "make": "Land Rover / Jaguar",
        "model": "Discovery 4/5, Defender L663 & Range Rover Sport (2010-2025)",
        "engine": "3.0L TDV6/SDV6 & Ingenium 2.0L/3.0L",
        "family": "generic",
        "wmi_prefixes": ["SAL", "SAJ"],
        "protocols": ["ISO15765_11_500", "MS_CAN_125"],
        "modules": [
            {"id": "PCM", "bus": "HS-CAN 500k", "tx": "0x7E0", "rx": "0x7E8", "network": "HS_CAN"},
            {"id": "TCM", "bus": "HS-CAN 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:HS_CAN_500K", "NODE:MS_CAN_125K", "NODE:CROSSOVER_EGR_PIPE"],
        "common_dtcs": {
            "P0299": "TDV6/SDV6 plastic inlet manifold crack or secondary turbo actuator fault.",
        },
    },
    "jeep_ram_stellantis": {
        "make": "Jeep / RAM",
        "model": "Wrangler JL, Grand Cherokee WK2 & RAM 1500 DT (2014-2025)",
        "engine": "3.6L Pentastar / 5.7L HEMI / 3.0L EcoDiesel",
        "family": "stellantis",
        "wmi_prefixes": ["1C4", "1C6"],
        "protocols": ["ISO15765_11_500"],
        "modules": [
            {
                "id": "PCM",
                "bus": "CAN-C 500k (SGW)",
                "tx": "0x7E0",
                "rx": "0x7E8",
                "network": "HS_CAN",
            },
            {"id": "TCM", "bus": "CAN-C 500k", "tx": "0x7E1", "rx": "0x7E9", "network": "HS_CAN"},
            {"id": "ABS", "bus": "CAN-C 500k", "tx": "0x747", "rx": "0x4C7", "network": "HS_CAN"},
        ],
        "shared_nodes": ["NODE:CAN_C_500K", "NODE:SGW_SECURITY_GATEWAY", "NODE:ESIM_EVAP_SWITCH"],
        "common_dtcs": {
            "P0456": "Small EVAP leak — replace ESIM purge integrity module on canister.",
        },
    },
}

SERVICE_FUNCTIONS_CATALOG: list[dict[str, Any]] = [
    {
        "id": "oil_reset",
        "name": "Oil Service / Maintenance Reset",
        "tier": "A",
        "uds_service": "0x31",
        "notes": "Resets service interval counter in IPC/PCM.",
    },
    {
        "id": "bms_reset",
        "name": "BMS Battery Registration",
        "tier": "A",
        "uds_service": "0x31",
        "notes": "Registers new AGM/EFB battery capacity & state-of-charge.",
    },
    {
        "id": "epb_service",
        "name": "EPB Caliper Retract / Service Mode",
        "tier": "A",
        "uds_service": "0x31",
        "notes": "Opens rear electronic parking brake calipers for pad replacement.",
    },
    {
        "id": "sas_cal",
        "name": "Steering Angle Sensor (SAS) Zero Calibration",
        "tier": "A",
        "uds_service": "0x31",
        "notes": "Zeros steering angle with wheels straight ahead.",
    },
    {
        "id": "dpf_regen",
        "name": "DPF Static Forced Regeneration",
        "tier": "B",
        "uds_service": "0x31",
        "notes": "Requires park/neutral, coolant >= 70C, battery >= 12.5V.",
    },
    {
        "id": "abs_bleed",
        "name": "ABS / VSC Automated Hydraulic Bleed",
        "tier": "B",
        "uds_service": "0x2F",
        "notes": "Actuates ABS pump & solenoids during brake fluid bleed.",
    },
    {
        "id": "injector_coding",
        "name": "Diesel Injector IMA / QR Coding",
        "tier": "B",
        "uds_service": "0x2E",
        "notes": "Writes injector trim codes to ECM.",
    },
    {
        "id": "throttle_relearn",
        "name": "Electronic Throttle Body Idle Relearn",
        "tier": "A",
        "uds_service": "0x31",
        "notes": "Relearns closed-throttle stop after cleaning.",
    },
    {
        "id": "tpms_relearn",
        "name": "TPMS Sensor ID Relearn",
        "tier": "A",
        "uds_service": "0x31",
        "notes": "Registers wheel TPMS sensor IDs in BCM.",
    },
    {
        "id": "radar_cal",
        "name": "Park Assist & Blind-Spot Radar Zero-Point Calibration",
        "tier": "B",
        "uds_service": "0x31",
        "notes": "Calibrates ultrasonic/radar baseline on flat ground.",
    },
    {
        "id": "ckp_relearn",
        "name": "Crankshaft Position (CKP) Sensor Relearn",
        "tier": "B",
        "uds_service": "0x31",
        "notes": "Clears P1336 / cam-crank variation after CKP/ECU replacement.",
    },
]


def list_vehicle_platforms() -> list[dict[str, Any]]:
    return [{"profile": k, **v} for k, v in VEHICLE_PLATFORMS.items()]


GENERIC_PROFILE = "generic_obd2_uds"

GENERIC_PLATFORM: dict[str, Any] = {
    "make": "Universal OBD-II / EOBD",
    "model": "Generic ISO 15765 / KWP2000 / J1850 Vehicle",
    "engine": "All OBD-II Compliant Powertrains",
    "family": "generic",
    "wmi_prefixes": [],
    "protocols": [
        "AUTO",
        "ISO15765_11_500",
        "ISO15765_29_500",
        "ISO14230_FAST",
        "ISO9141_2",
        "J1850_PWM",
        "J1850_VPW",
    ],
    "modules": [
        {
            "id": "ECM/PCM",
            "bus": "OBD-II Functional",
            "tx": "0x7DF",
            "rx": "0x7E8",
            "network": "HS_CAN",
        }
    ],
    "shared_nodes": ["NODE:OBD2_PIN16_BATT", "NODE:OBD2_PIN4_5_GND"],
    "common_dtcs": {},
}

# Profiles that were renamed or split; saved jobs keep working.
LEGACY_PROFILES: dict[str, str] = {"mazda_bt50_cx5": "mazda_cx5_mazda3"}


def resolve_profile(profile: str | None) -> str | None:
    if not profile:
        return None
    return LEGACY_PROFILES.get(profile, profile)


def get_vehicle_platform(profile: str | None) -> dict[str, Any]:
    """The platform for a profile; unknown or missing profiles get generic OBD-II
    (never another vehicle's data)."""
    return VEHICLE_PLATFORMS.get(resolve_profile(profile) or "", GENERIC_PLATFORM)


# VIN position 10. Letters repeat every 30 years (A = 1980 or 2010); digits are 2001-2009.
_YEAR_CHARS = "ABCDEFGHJKLMNPRSTVWXY123456789"


def vin_model_year(vin: str, today_year: int | None = None) -> int | None:
    """Model year from VIN position 10, or None if it can't be read.

    For the repeating letter codes, the latest year not more than one year
    ahead of today is used (a 2026 "A" is 2010, never 2040).
    """
    clean = vin.strip().upper()
    if len(clean) < 10:
        return None
    ch = clean[9]
    if ch not in _YEAR_CHARS:
        return None
    idx = _YEAR_CHARS.index(ch)
    if ch.isdigit():
        return 2001 + "123456789".index(ch)
    if today_year is None:
        from datetime import date

        today_year = date.today().year
    year = 1980 + idx
    while year + 30 <= today_year + 1:
        year += 30
    return year


def decode_vin_platform(vin: str) -> dict[str, Any]:
    """Match the VIN's maker code (WMI) and, where platforms share one, its model year.

    When several platforms fit the same year (a changeover year such as a 2018
    or 2022 Ranger), the first is used and ``ambiguous_with`` lists the others
    so the technician can pick.
    """
    clean = vin.strip().upper()
    wmi = clean[:3]
    year = vin_model_year(clean)
    candidates = [
        (profile, info)
        for profile, info in VEHICLE_PLATFORMS.items()
        if wmi in info["wmi_prefixes"]
    ]
    if year is not None and any("years" in info for _, info in candidates):
        dated = [
            (profile, info)
            for profile, info in candidates
            if "years" not in info or info["years"][0] <= year <= info["years"][1]
        ]
        candidates = dated or candidates
    if candidates:
        profile, info = candidates[0]
        return {
            "matched": True,
            "profile": profile,
            "wmi": wmi,
            "model_year": year,
            "ambiguous_with": [p for p, _ in candidates[1:]],
            **info,
        }
    return {
        "matched": False,
        "profile": GENERIC_PROFILE,
        "wmi": wmi,
        "model_year": year,
        "ambiguous_with": [],
        **GENERIC_PLATFORM,
    }
