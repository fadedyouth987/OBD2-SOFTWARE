//! Task 1.3 verification gate: heuristics produce the exact alerts in
//! `fixtures/heuristics/`, the cross-module audit works end to end on the
//! virtual vehicles, and A-ENG-2's speed source refuses when no fresh speed exists.

use std::sync::Arc;

use edge_daemon::{
    analytics::{
        did_maps::{self, ModuleAddr, SpeedPlan},
        heuristics::{self, AuditInput},
    },
    hal::{
        virtual_bus::VirtualBus, virtual_kline::VirtualKLineAdapter, KLineAdapter,
        VehicleBusAdapter,
    },
    protocol::{
        self,
        messages::{DiagProtocol, EdgeMessage, HeuristicAlert, PidSample, SafetyMode},
    },
    protocols::{
        isotp::{IsoTpConfig, IsoTpLink},
        kline::KLineLink,
        DiagChannel, Timing,
    },
    safety::{
        audit::MemoryAudit,
        interlock::{GatedRequest, RefusalCode, SafetyInterlock},
    },
    sim::{profiles, DID_ODOMETER, DID_VIN},
};
use serde_json::Value;

fn interlock() -> Arc<SafetyInterlock> {
    Arc::new(SafetyInterlock::new(
        "s-heur",
        Arc::new(MemoryAudit::default()),
    ))
}

fn as_values(alerts: &[HeuristicAlert]) -> Vec<Value> {
    alerts
        .iter()
        .map(|a| {
            let wire = protocol::to_wire(&EdgeMessage::from(a.clone()));
            protocol::parse_message(&wire).expect("alert passes the wire schema");
            serde_json::from_str(&wire).unwrap()
        })
        .collect()
}

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/fixtures/heuristics/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn run_fixture(name: &str) -> (Vec<Value>, Vec<Value>) {
    let f = fixture(name);
    let alerts = match f["kind"].as_str().unwrap() {
        "fuel_trim" => heuristics::fuel_trim(
            &serde_json::from_value::<Vec<PidSample>>(f["input"].clone()).unwrap(),
        ),
        "cold_soak" => heuristics::cold_soak(
            &serde_json::from_value::<Vec<PidSample>>(f["input"].clone()).unwrap(),
        ),
        "audit" => heuristics::cross_module_audit(
            &serde_json::from_value::<AuditInput>(f["input"].clone()).unwrap(),
        ),
        other => panic!("unknown fixture kind {other}"),
    };
    (
        as_values(&alerts),
        f["expected"].as_array().unwrap().clone(),
    )
}

/// Gate: fixtures produce exact alerts for vacuum leak, odometer mismatch,
/// recently cleared ECU and unsupported vehicle (plus cold-soak divergence).
#[test]
fn fixtures_produce_exact_alerts() {
    for name in [
        "vacuum_leak",
        "odometer_mismatch",
        "recently_cleared",
        "unsupported_vehicle",
        "cold_soak_divergence",
    ] {
        let (got, expected) = run_fixture(name);
        assert_eq!(got, expected, "{name}");
    }
}

async fn can_channel(
    bus: &VirtualBus,
    module: &did_maps::ModuleMap,
    lock: &Arc<SafetyInterlock>,
) -> DiagChannel {
    let ModuleAddr::Can(addr) = module.addr else {
        panic!("CAN module expected")
    };
    let mut adapter = bus.adapter();
    adapter.open(bus.bitrate()).await.unwrap();
    let link = IsoTpLink::new(adapter, addr, IsoTpConfig::default())
        .await
        .unwrap();
    DiagChannel::isotp(link, lock.clone())
}

async fn audit_can_vehicle(bus: &VirtualBus, profile_id: &str) -> Vec<String> {
    let lock = interlock();
    let map = did_maps::for_profile(profile_id).unwrap();
    let mut readings = Vec::new();
    for module in &map.modules {
        let mut ch = can_channel(bus, module, &lock).await;
        readings.push(heuristics::collect_module(&mut ch, module).await);
    }
    let obd_module = map.modules.iter().find(|m| m.obd).unwrap();
    let mut obd = can_channel(bus, obd_module, &lock).await;
    let status = heuristics::collect_obd_status(&mut obd).await;
    let alerts =
        heuristics::cross_module_audit(&heuristics::audit_input(Some(&map), readings, status));
    alerts.iter().map(|a| a.rule_id.to_string()).collect()
}

/// The audit end to end on the virtual Falcon: rolled-back cluster, codes just cleared.
#[tokio::test(start_paused = true)]
async fn audit_detects_rollback_and_recent_clear_on_falcon() {
    let bus = VirtualBus::from_profile_id(profiles::falcon_ba::ID).unwrap();
    assert!(
        audit_can_vehicle(&bus, profiles::falcon_ba::ID)
            .await
            .is_empty(),
        "clean car, no alerts"
    );

    bus.with_ecu("IC", |ic| {
        ic.set_did(DID_ODOMETER, 98_000u32.to_be_bytes()[1..].to_vec())
    })
    .unwrap();
    bus.with_vehicle(|v| {
        v.distance_since_clear_km = 12;
        v.monitors_complete = false;
    });
    assert_eq!(
        audit_can_vehicle(&bus, profiles::falcon_ba::ID).await,
        vec!["audit.odometer_mismatch", "audit.codes_recently_cleared"]
    );
}

/// VIN mismatch on the virtual D-CAN E90: the CAS came from another car.
#[tokio::test(start_paused = true)]
async fn audit_detects_swapped_module_on_e90_dcan() {
    let bus = VirtualBus::from_profile_id(profiles::e90_dcan::ID).unwrap();
    bus.with_ecu("CAS", |cas| {
        cas.set_did(DID_VIN, b"WBAVB11090PT99999".to_vec())
    })
    .unwrap();
    assert_eq!(
        audit_can_vehicle(&bus, profiles::e90_dcan::ID).await,
        vec!["audit.vin_mismatch"]
    );
}

#[test]
fn unknown_vehicle_is_not_supported() {
    let map = did_maps::for_profile("holden-vt-1998");
    let alerts = heuristics::cross_module_audit(&heuristics::audit_input(
        map.as_ref(),
        Vec::new(),
        (None, None),
    ));
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].rule_id.as_str(), "audit.not_supported");
}

/// A-ENG-2 gate: on the K-line E90, a DSC session has no speed source, so a
/// gated request is refused with PRECONDITION_UNKNOWN; the DME supplies speed itself.
#[tokio::test(start_paused = true)]
async fn kline_speed_source_refuses_without_fresh_speed() {
    let map = did_maps::for_profile(profiles::e90_pre2007::ID).unwrap();
    let lock = interlock();
    lock.set_mode(SafetyMode::ActiveConfirmed);

    // Session with the DSC: no speed without dropping the session.
    let mut adapter = VirtualKLineAdapter::from_profile_id(profiles::e90_pre2007::ID).unwrap();
    adapter.open(10_400).await.unwrap();
    let (link, _) = KLineLink::connect_fast(adapter, profiles::e90_pre2007::DSC, Timing::KLINE)
        .await
        .unwrap();
    let ch = DiagChannel::kline(link, lock.clone());
    assert!(matches!(
        map.speed_plan("DSC"),
        SpeedPlan::Unavailable { .. }
    ));
    let (tx, rx) = ch.ids();
    let clear = [0x14, 0xFF, 0x00];
    let refusal = lock
        .issue_token(
            &GatedRequest {
                protocol: DiagProtocol::Kwp2000,
                tx,
                rx,
                payload: &clear,
            },
            "Clear DSC faults",
        )
        .unwrap_err();
    assert_eq!(refusal.code, RefusalCode::PreconditionUnknown);

    // Session with the DME: it answers PID 0x0D itself.
    let mut adapter = VirtualKLineAdapter::from_profile_id(profiles::e90_pre2007::ID).unwrap();
    adapter.open(10_400).await.unwrap();
    let (link, _) = KLineLink::connect_fast(adapter, profiles::e90_pre2007::DME, Timing::KLINE)
        .await
        .unwrap();
    let mut dme = DiagChannel::kline(link, lock.clone());
    assert_eq!(map.speed_plan("DME"), SpeedPlan::FromTarget);
    assert_eq!(
        heuristics::refresh_speed(&mut dme, &lock).await.unwrap(),
        0.0
    );
    let (tx, rx) = dme.ids();
    assert!(lock
        .issue_token(
            &GatedRequest {
                protocol: DiagProtocol::Kwp2000,
                tx,
                rx,
                payload: &clear
            },
            "Clear DME faults"
        )
        .is_ok());

    // Two seconds later the reading is stale again (Rule 5).
    tokio::time::advance(std::time::Duration::from_millis(2_100)).await;
    let refusal = lock
        .issue_token(
            &GatedRequest {
                protocol: DiagProtocol::Kwp2000,
                tx,
                rx,
                payload: &clear,
            },
            "Clear DME faults",
        )
        .unwrap_err();
    assert_eq!(refusal.code, RefusalCode::PreconditionUnknown);
}
