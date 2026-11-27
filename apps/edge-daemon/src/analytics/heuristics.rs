//! Deterministic edge heuristics (Task 1.3). Each rule returns wire
//! `HeuristicAlert`s, so what the tests check is exactly what the web app gets.
//!
//! - Fuel-trim matrix: STFT + LTFT per bank at idle vs 2,500 rpm.
//! - Cold-soak divergence: |ECT - IAT| at key-on, engine off.
//! - Cross-module audit: VIN and odometer across modules (via `did_maps`),
//!   distance since codes cleared and readiness monitors.
//!
//! Rule 6: a check that cannot run on this vehicle says so (INFO), never passes.

use serde_json::{json, Value};

use super::did_maps::{DidMap, IdRead, ModuleMap};
use crate::{
    protocol::messages::{HeuristicAlert, HeuristicAlertType, PidSample, Severity},
    protocols::{obd::Obd, positive, DiagError, DiagTransport},
    safety::interlock::SafetyInterlock,
};

/// Fuel trim (STFT + LTFT) above this at idle counts as lean.
pub const TRIM_LEAN_PCT: f64 = 12.0;
/// Trim within this of zero under load counts as normalized.
pub const TRIM_NORMAL_PCT: f64 = 5.0;
pub const IDLE_RPM: (f64, f64) = (550.0, 1_100.0);
pub const LOAD_RPM: (f64, f64) = (2_250.0, 2_750.0);
/// Snapshots needed in each window before the matrix is judged.
pub const MIN_SAMPLES: usize = 5;
pub const COLD_SOAK_LIMIT_C: f64 = 6.0;
/// Codes cleared within this distance are "recently cleared".
pub const RECENT_CLEAR_KM: u32 = 50;
/// Odometers across modules may legitimately lag by this much.
pub const ODOMETER_TOLERANCE_KM: u32 = 50;

const PID_STFT: [u8; 2] = [0x06, 0x08];
const PID_LTFT: [u8; 2] = [0x07, 0x09];
const PID_ECT: u8 = 0x05;
const PID_RPM: u8 = 0x0C;
const PID_IAT: u8 = 0x0F;

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// Builds a wire alert. Panics only on a malformed literal in this file.
pub fn alert(
    rule_id: &str,
    severity: Severity,
    title: &str,
    evidence: Value,
    recommended_test: &str,
) -> HeuristicAlert {
    let Value::Object(evidence_json) = evidence else {
        panic!("evidence must be an object")
    };
    HeuristicAlert {
        evidence_json,
        recommended_test: recommended_test
            .try_into()
            .expect("recommended_test within schema limits"),
        rule_id: rule_id
            .try_into()
            .expect("rule id matches the schema pattern"),
        severity,
        title: title.try_into().expect("title within schema limits"),
        type_: HeuristicAlertType::HeuristicAlert,
    }
}

/// Snapshots: for each trim sample, the latest RPM at or before it.
fn trim_snapshots(samples: &[PidSample]) -> Vec<(f64, [Option<f64>; 2])> {
    let mut sorted: Vec<&PidSample> = samples.iter().collect();
    sorted.sort_by_key(|s| s.timestamp_us.0);
    let mut rpm = None;
    let mut stft = [None, None];
    let mut ltft = [None, None];
    let mut out = Vec::new();
    let mut last_ts = None;
    for s in sorted {
        // A new timestamp closes the previous snapshot.
        if last_ts.is_some_and(|t| t != s.timestamp_us.0) {
            if let Some(r) = rpm {
                let totals = [0, 1].map(|b| Some(stft[b]? + ltft[b]?));
                if totals.iter().any(Option::is_some) {
                    out.push((r, totals));
                }
            }
            // Long-term trims move slowly and are polled less often than the
            // short-term ones, so the last value carries into later snapshots.
            stft = [None, None];
        }
        last_ts = Some(s.timestamp_us.0);
        let pid = s.pid as u8;
        match pid {
            PID_RPM => rpm = Some(s.value),
            p if p == PID_STFT[0] => stft[0] = Some(s.value),
            p if p == PID_STFT[1] => stft[1] = Some(s.value),
            p if p == PID_LTFT[0] => ltft[0] = Some(s.value),
            p if p == PID_LTFT[1] => ltft[1] = Some(s.value),
            _ => {}
        }
    }
    if let Some(r) = rpm {
        let totals = [0, 1].map(|b| Some(stft[b]? + ltft[b]?));
        if totals.iter().any(Option::is_some) {
            out.push((r, totals));
        }
    }
    out
}

/// Fuel-trim matrix (AMBER). Lean (> +12%) at idle that normalizes at
/// 2,500 rpm points to an unmetered air leak; lean at both points to fuel
/// delivery or MAF bias. Needs at least `MIN_SAMPLES` snapshots per window.
pub fn fuel_trim(samples: &[PidSample]) -> Vec<HeuristicAlert> {
    let snaps = trim_snapshots(samples);
    let window = |(lo, hi): (f64, f64), bank: usize| -> Vec<f64> {
        snaps
            .iter()
            .filter(|(rpm, _)| *rpm >= lo && *rpm <= hi)
            .filter_map(|(_, t)| t[bank])
            .collect()
    };
    let mut leak = Vec::new();
    let mut delivery = Vec::new();
    let mut evidence = serde_json::Map::new();
    for bank in 0..2 {
        let (idle, load) = (window(IDLE_RPM, bank), window(LOAD_RPM, bank));
        if idle.len() < MIN_SAMPLES || load.len() < MIN_SAMPLES {
            continue;
        }
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let (idle_t, load_t) = (round1(mean(&idle)), round1(mean(&load)));
        evidence.insert(
            format!("bank{}", bank + 1),
            json!({ "idle_total_pct": idle_t, "load_total_pct": load_t, "idle_samples": idle.len(), "load_samples": load.len() }),
        );
        if idle_t > TRIM_LEAN_PCT && load_t.abs() <= TRIM_NORMAL_PCT {
            leak.push(bank + 1);
        } else if idle_t > TRIM_LEAN_PCT && load_t > TRIM_LEAN_PCT {
            delivery.push(bank + 1);
        }
    }
    let mut alerts = Vec::new();
    let with = |banks: &[usize], rule: &str| {
        let mut e = evidence.clone();
        e.insert("banks".into(), json!(banks));
        e.insert("rule".into(), json!(rule));
        e.insert("lean_threshold_pct".into(), json!(TRIM_LEAN_PCT));
        Value::Object(e)
    };
    if !leak.is_empty() {
        alerts.push(alert(
            "fuel_trim.vacuum_leak",
            Severity::Amber,
            "Lean at idle, normal at 2,500 rpm: likely vacuum or intake leak",
            with(&leak, "idle > +12% total trim, within ±5% at 2,500 rpm"),
            "Smoke-test the intake between the MAF and the cylinder head; check the PCV valve and brake booster hose.",
        ));
    }
    if !delivery.is_empty() {
        alerts.push(alert(
            "fuel_trim.fuel_delivery_or_maf",
            Severity::Amber,
            "Lean at idle and at 2,500 rpm: check fuel pressure and MAF",
            with(&delivery, "> +12% total trim at idle and at 2,500 rpm"),
            "Measure fuel rail pressure at idle and under load; compare MAF g/s with the expected value for engine size and rpm.",
        ));
    }
    alerts
}

/// Cold-soak divergence (AMBER): with the engine off at key-on, coolant and
/// intake air should read within 6 °C of each other.
pub fn cold_soak(samples: &[PidSample]) -> Vec<HeuristicAlert> {
    let mut sorted: Vec<&PidSample> = samples.iter().collect();
    sorted.sort_by_key(|s| s.timestamp_us.0);
    let (mut rpm, mut ect, mut iat) = (None, None, None);
    for s in sorted {
        match s.pid as u8 {
            PID_RPM => {
                if s.value > 0.0 {
                    break; // engine started: key-on window is over
                }
                rpm = Some(s.value);
            }
            PID_ECT if ect.is_none() => ect = Some(s.value),
            PID_IAT if iat.is_none() => iat = Some(s.value),
            _ => {}
        }
    }
    let (Some(_), Some(ect), Some(iat)) = (rpm, ect, iat) else {
        return Vec::new();
    };
    let divergence = round1((ect - iat).abs());
    if divergence <= COLD_SOAK_LIMIT_C {
        return Vec::new();
    }
    vec![alert(
        "thermal.cold_soak_divergence",
        Severity::Amber,
        "Coolant and intake air temperatures disagree at key-on",
        json!({
            "ect_c": round1(ect),
            "iat_c": round1(iat),
            "divergence_c": divergence,
            "limit_c": COLD_SOAK_LIMIT_C,
            "false_positive_note": "A car parked in direct sun, or driven within the last few hours (heat soak), can show this without a fault. Only trust it after the engine has sat for 6+ hours in the shade."
        }),
        "Compare both sensors with an infrared thermometer on a cold engine; measure each sensor's resistance against its temperature chart.",
    )]
}

/// What the audit read from one module.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ModuleReading {
    pub module: String,
    pub vin: Option<String>,
    pub odometer_km: Option<u32>,
}

/// Everything the cross-module audit looks at.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AuditInput {
    /// False when the vehicle has no `did_maps` entry.
    pub supported: bool,
    pub modules: Vec<ModuleReading>,
    /// PID 0x31, km since DTCs were cleared.
    pub distance_since_clear_km: Option<u32>,
    /// Readiness monitors supported but not complete (from PID 0x01).
    pub incomplete_monitors: Option<u32>,
}

/// Cross-module forensic audit.
pub fn cross_module_audit(input: &AuditInput) -> Vec<HeuristicAlert> {
    if !input.supported {
        return vec![alert(
            "audit.not_supported",
            Severity::Info,
            "VIN and odometer audit not supported for this vehicle",
            json!({ "reason": "no module identifier map for this vehicle" }),
            "",
        )];
    }
    let mut alerts = Vec::new();
    let vins: Vec<(&str, &str)> = input
        .modules
        .iter()
        .filter_map(|m| Some((m.module.as_str(), m.vin.as_deref()?)))
        .collect();
    if vins.windows(2).any(|w| w[0].1 != w[1].1) {
        let evidence: serde_json::Map<String, Value> = vins
            .iter()
            .map(|(m, v)| ((*m).to_owned(), json!(v)))
            .collect();
        alerts.push(alert(
            "audit.vin_mismatch",
            Severity::Red,
            "VIN differs between modules",
            json!({ "vins": evidence }),
            "Check whether a module was replaced or swapped from another car; compare with the VIN plate and build records.",
        ));
    }
    let odos: Vec<(&str, u32)> = input
        .modules
        .iter()
        .filter_map(|m| Some((m.module.as_str(), m.odometer_km?)))
        .collect();
    if let (Some(min), Some(max)) = (
        odos.iter().map(|o| o.1).min(),
        odos.iter().map(|o| o.1).max(),
    ) {
        if max - min > ODOMETER_TOLERANCE_KM {
            let evidence: serde_json::Map<String, Value> = odos
                .iter()
                .map(|(m, km)| ((*m).to_owned(), json!(km)))
                .collect();
            alerts.push(alert(
                "audit.odometer_mismatch",
                Severity::Red,
                "Odometer readings differ between modules: possible rollback",
                json!({ "odometer_km": evidence, "spread_km": max - min, "tolerance_km": ODOMETER_TOLERANCE_KM }),
                "Compare with service records and registration history; the lowest module reading may have been altered.",
            ));
        }
    }
    let recent = input
        .distance_since_clear_km
        .is_some_and(|d| d < RECENT_CLEAR_KM);
    let incomplete = input.incomplete_monitors.is_some_and(|n| n > 0);
    if recent || incomplete {
        alerts.push(alert(
            "audit.codes_recently_cleared",
            Severity::Amber,
            "Codes recently cleared",
            json!({
                "distance_since_clear_km": input.distance_since_clear_km,
                "incomplete_monitors": input.incomplete_monitors,
                "recent_clear_km": RECENT_CLEAR_KM
            }),
            "Ask when codes were last cleared; road-test until the readiness monitors complete, then re-scan.",
        ));
    }
    alerts
}

/// Reads one identifier from a module.
async fn read_id<T: DiagTransport + ?Sized>(
    t: &mut T,
    module: &ModuleMap,
    read: IdRead,
) -> Result<Vec<u8>, DiagError> {
    let IdRead::ReadDid(did) = read;
    let [hi, lo] = did.to_be_bytes();
    let resp = positive(t, module.protocol, &[0x22, hi, lo], None, 3).await?;
    Ok(resp[3..].to_vec())
}

/// Reads VIN and odometer from one module. A module that refuses or does not
/// answer contributes nothing rather than failing the audit.
pub async fn collect_module<T: DiagTransport + ?Sized>(
    t: &mut T,
    module: &ModuleMap,
) -> ModuleReading {
    let mut reading = ModuleReading {
        module: module.name.to_owned(),
        vin: None,
        odometer_km: None,
    };
    if let Some(read) = module.vin {
        if let Ok(bytes) = read_id(t, module, read).await {
            let vin = String::from_utf8_lossy(&bytes)
                .trim_matches(char::from(0))
                .trim()
                .to_owned();
            reading.vin = (!vin.is_empty()).then_some(vin);
        }
    }
    if let Some(read) = module.odometer {
        if let Ok(bytes) = read_id(t, module, read).await {
            if bytes.len() >= 3 {
                reading.odometer_km = Some(u32::from_be_bytes([0, bytes[0], bytes[1], bytes[2]]));
            }
        }
    }
    reading
}

/// PID 0x31 and readiness monitors from an OBD module.
pub async fn collect_obd_status<T: DiagTransport + ?Sized>(
    t: &mut T,
) -> (Option<u32>, Option<u32>) {
    let mut obd = Obd(t);
    let distance = match obd.read_pids_raw(&[0x31]).await {
        Ok(v) => v
            .into_iter()
            .find(|(p, _)| *p == 0x31)
            .map(|(_, d)| u32::from(u16::from_be_bytes([d[0], d[1]]))),
        Err(_) => None,
    };
    let monitors = match obd.read_pids_raw(&[0x01]).await {
        Ok(v) => v.into_iter().find(|(p, _)| *p == 0x01).map(|(_, d)| {
            let continuous = (d[1] & 0x07) & (d[1] >> 4);
            (continuous.count_ones()) + (d[2] & d[3]).count_ones()
        }),
        Err(_) => None,
    };
    (distance, monitors)
}

/// The audit input for a vehicle; `None` map means unsupported.
pub fn audit_input(
    map: Option<&DidMap>,
    modules: Vec<ModuleReading>,
    obd: (Option<u32>, Option<u32>),
) -> AuditInput {
    AuditInput {
        supported: map.is_some(),
        modules,
        distance_since_clear_km: obd.0,
        incomplete_monitors: obd.1,
    }
}

/// Reads PID 0x0D over `t` and feeds it to the interlock (Rule 5: only fresh
/// readings count). Returns the speed.
pub async fn refresh_speed<T: DiagTransport + ?Sized>(
    t: &mut T,
    interlock: &SafetyInterlock,
) -> Result<f64, DiagError> {
    let values = Obd(t).read_pids(&[0x0D]).await?;
    let speed = values
        .into_iter()
        .find(|v| v.pid == 0x0D)
        .map(|v| v.value)
        .ok_or_else(|| DiagError::Unexpected("no PID 0x0D in the response".into()))?;
    interlock.update_speed(speed);
    Ok(speed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t_ms: u64, pid: u8, value: f64) -> PidSample {
        PidSample {
            name: "x".try_into().unwrap(),
            pid: u16::from(pid),
            timestamp_us: crate::protocol::messages::TimestampUs(t_ms * 1_000),
            unit: "".try_into().unwrap(),
            value,
        }
    }

    fn snapshot(t: u64, rpm: f64, stft: f64, ltft: f64) -> Vec<PidSample> {
        vec![s(t, PID_RPM, rpm), s(t, 0x06, stft), s(t, 0x07, ltft)]
    }

    #[test]
    fn long_term_trim_carries_into_later_snapshots() {
        // LTFT arrives on the slow poll only; every fast snapshot still counts.
        let mut samples = snapshot(0, 800.0, 10.0, 5.0);
        for t in 1..5 {
            samples.extend([s(t * 50, PID_RPM, 800.0), s(t * 50, 0x06, 10.0)]);
        }
        samples.push(s(250, PID_RPM, 800.0)); // closes the last snapshot
        let snaps = trim_snapshots(&samples);
        assert_eq!(snaps.len(), 5, "{snaps:?}");
        assert!(snaps.iter().all(|(_, t)| t[0] == Some(15.0)), "{snaps:?}");
    }

    #[test]
    fn fuel_trim_needs_both_windows() {
        let idle: Vec<PidSample> = (0..10)
            .flat_map(|i| snapshot(i * 100, 800.0, 9.0, 6.0))
            .collect();
        assert!(fuel_trim(&idle).is_empty(), "no 2,500 rpm data");
    }

    #[test]
    fn fuel_trim_delivery_bias() {
        let mut v: Vec<PidSample> = (0..6)
            .flat_map(|i| snapshot(i * 100, 780.0, 8.0, 7.0))
            .collect();
        v.extend((0..6).flat_map(|i| snapshot(1_000 + i * 100, 2_500.0, 7.0, 7.5)));
        let alerts = fuel_trim(&v);
        assert_eq!(alerts.len(), 1);
        assert_eq!(alerts[0].rule_id.as_str(), "fuel_trim.fuel_delivery_or_maf");
    }

    #[test]
    fn cold_soak_within_limit_is_quiet() {
        let v = vec![s(0, PID_RPM, 0.0), s(0, PID_ECT, 18.0), s(0, PID_IAT, 21.0)];
        assert!(cold_soak(&v).is_empty());
        // Readings only after the engine started do not count.
        let v = vec![
            s(0, PID_RPM, 900.0),
            s(1, PID_ECT, 80.0),
            s(1, PID_IAT, 25.0),
        ];
        assert!(cold_soak(&v).is_empty());
    }

    #[test]
    fn audit_tolerates_small_odometer_lag() {
        let input = AuditInput {
            supported: true,
            modules: vec![
                ModuleReading {
                    module: "A".into(),
                    vin: Some("V".into()),
                    odometer_km: Some(1_000),
                },
                ModuleReading {
                    module: "B".into(),
                    vin: Some("V".into()),
                    odometer_km: Some(1_030),
                },
            ],
            distance_since_clear_km: Some(900),
            incomplete_monitors: Some(0),
        };
        assert!(cross_module_audit(&input).is_empty());
    }
}
