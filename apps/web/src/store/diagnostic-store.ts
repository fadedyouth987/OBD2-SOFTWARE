"use client";

export type SafetyMode = "SILENT" | "ACTIVE_CONFIRMED";

export interface DtcRecord {
  code: string;
  module: string;
  severity: "CRIT" | "WARN" | "INFO";
  title: string;
  confidenceBand: "HIGH" | "MEDIUM" | "LOW";
  citedNodes: string[];
  citedCases: string[];
}

export interface DiagnosticState {
  vehicleId: string;
  vehicleName: string;
  vin: string;
  protocol: string;
  safetyMode: SafetyMode;
  speedKmh: number;
  rpm: number;
  batteryV: number;
  coolantC: number;
  dtcs: DtcRecord[];
}

export const INITIAL_DIAGNOSTIC_STATE: DiagnosticState = {
  vehicleId: "FLT-104",
  vehicleName: "2023 Ford Ranger Wildtrak",
  vin: "MPBUMFF60••••••••",
  protocol: "HS-CAN 500k",
  safetyMode: "SILENT",
  speedKmh: 0,
  rpm: 780,
  batteryV: 14.1,
  coolantC: 89,
  dtcs: [
    {
      code: "P2463",
      module: "PCM",
      severity: "WARN",
      title: "DPF Restriction - Soot Accumulation",
      confidenceBand: "HIGH",
      citedNodes: ["NODE:EXH_DPF_DIFF_PRESS", "NODE:PCM_PIN_44_5V_REF"],
      citedCases: ["CASE-AU-2026-0142"],
    },
  ],
};
