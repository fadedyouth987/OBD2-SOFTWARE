// Generic SAE J2012 / ISO 15031-6 descriptions for common codes. Codes whose
// second character is 1 (P1xxx, C1xxx, B1xxx, U1xxx) or 3 (P3xxx) are
// manufacturer-specific; we say so rather than guess.

const GENERIC: Record<string, string> = {
  P0010: "Camshaft position actuator circuit (bank 1)",
  P0011: "Camshaft timing over-advanced (bank 1)",
  P0016: "Crankshaft/camshaft position correlation (bank 1 sensor A)",
  P0017: "Crankshaft/camshaft position correlation (bank 1 sensor B)",
  P0087: "Fuel rail/system pressure too low",
  P0088: "Fuel rail/system pressure too high",
  P0100: "Mass air flow circuit",
  P0101: "Mass air flow circuit range/performance",
  P0102: "Mass air flow circuit low",
  P0103: "Mass air flow circuit high",
  P0106: "Manifold pressure circuit range/performance",
  P0110: "Intake air temperature circuit",
  P0113: "Intake air temperature circuit high",
  P0115: "Engine coolant temperature circuit",
  P0116: "Engine coolant temperature circuit range/performance",
  P0117: "Engine coolant temperature circuit low",
  P0118: "Engine coolant temperature circuit high",
  P0120: "Throttle position sensor A circuit",
  P0121: "Throttle position sensor A range/performance",
  P0128: "Coolant below thermostat regulating temperature",
  P0130: "O2 sensor circuit (bank 1 sensor 1)",
  P0131: "O2 sensor circuit low voltage (bank 1 sensor 1)",
  P0133: "O2 sensor slow response (bank 1 sensor 1)",
  P0135: "O2 sensor heater circuit (bank 1 sensor 1)",
  P0141: "O2 sensor heater circuit (bank 1 sensor 2)",
  P0171: "System too lean (bank 1)",
  P0172: "System too rich (bank 1)",
  P0174: "System too lean (bank 2)",
  P0175: "System too rich (bank 2)",
  P0190: "Fuel rail pressure sensor circuit",
  P0201: "Injector circuit (cylinder 1)",
  P0234: "Turbocharger overboost condition",
  P0299: "Turbocharger underboost",
  P0300: "Random/multiple cylinder misfire detected",
  P0301: "Cylinder 1 misfire detected",
  P0302: "Cylinder 2 misfire detected",
  P0303: "Cylinder 3 misfire detected",
  P0304: "Cylinder 4 misfire detected",
  P0305: "Cylinder 5 misfire detected",
  P0306: "Cylinder 6 misfire detected",
  P0307: "Cylinder 7 misfire detected",
  P0308: "Cylinder 8 misfire detected",
  P0325: "Knock sensor 1 circuit (bank 1)",
  P0335: "Crankshaft position sensor A circuit",
  P0340: "Camshaft position sensor A circuit (bank 1)",
  P0341: "Camshaft position sensor A range/performance (bank 1)",
  P0380: "Glow plug/heater circuit A",
  P0400: "Exhaust gas recirculation flow",
  P0401: "Exhaust gas recirculation flow insufficient",
  P0402: "Exhaust gas recirculation flow excessive",
  P0403: "Exhaust gas recirculation control circuit",
  P0420: "Catalyst system efficiency below threshold (bank 1)",
  P0430: "Catalyst system efficiency below threshold (bank 2)",
  P0440: "Evaporative emission system",
  P0441: "Evaporative emission system incorrect purge flow",
  P0442: "Evaporative emission system leak detected (small leak)",
  P0446: "Evaporative emission vent control circuit",
  P0455: "Evaporative emission system leak detected (large leak)",
  P0456: "Evaporative emission system leak detected (very small leak)",
  P0500: "Vehicle speed sensor A",
  P0505: "Idle air control system",
  P0506: "Idle control system RPM lower than expected",
  P0507: "Idle control system RPM higher than expected",
  P0562: "System voltage low",
  P0563: "System voltage high",
  P0600: "Serial communication link",
  P0601: "Internal control module memory checksum error",
  P0606: "Control module processor",
  P0700: "Transmission control system (MIL request)",
  P0705: "Transmission range sensor circuit",
  P0715: "Input/turbine speed sensor A circuit",
  P0720: "Output speed sensor circuit",
  P0740: "Torque converter clutch solenoid circuit",
  P0750: "Shift solenoid A",
  P2002: "Diesel particulate filter efficiency below threshold (bank 1)",
  P2263: "Turbocharger boost system performance",
  P2463: "Diesel particulate filter restriction: soot accumulation",
  P242F: "Diesel particulate filter restriction: ash accumulation",
  U0100: "Lost communication with ECM/PCM A",
  U0101: "Lost communication with TCM",
  U0121: "Lost communication with anti-lock brake system module",
  U0140: "Lost communication with body control module",
  U0155: "Lost communication with instrument panel cluster",
};

export interface DtcInfo {
  description: string;
  kind: "generic" | "manufacturer" | "unknown";
}

export function describeDtc(code: string): DtcInfo {
  const c = code.toUpperCase();
  if (GENERIC[c]) return { description: GENERIC[c], kind: "generic" };
  const second = c[1];
  if (second === "1" || (c[0] === "P" && second === "3")) {
    return {
      description: "Manufacturer-specific code. Check the OEM service information for its meaning.",
      kind: "manufacturer",
    };
  }
  return { description: "Not in the code library yet.", kind: "unknown" };
}
