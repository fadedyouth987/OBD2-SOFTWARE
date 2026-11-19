//! Task 1.2 verification gate, end to end through the public API only
//! (`DiagChannel` + clients) against the virtual vehicles.

use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use async_trait::async_trait;
use edge_daemon::{
    hal::{
        serial::ReplaySerial,
        stn_elm::{StnElmAdapter, StnProtocol},
        virtual_bus::VirtualBus,
        virtual_kline::VirtualKLineAdapter,
        CanFilter, CanFrame, KLineAdapter, KeyBytes, VehicleBusAdapter,
    },
    protocol::{self, messages::DiagProtocol, messages::SafetyMode},
    protocols::{
        addressing::CanAddressing,
        isotp::{IsoTpConfig, IsoTpLink},
        kline::{ElmKLineLink, KLineLink},
        kwp2000::Kwp,
        obd::Obd,
        uds::{Uds, SESSION_EXTENDED},
        DiagChannel, DiagError, DiagRequest, DiagTransport, Timing,
    },
    safety::{
        audit::{MemoryAudit, Outcome},
        interlock::{GatedRequest, RefusalCode, SafetyInterlock},
    },
    sim::profiles::{e90_dcan, e90_pre2007, falcon_ba, generic_uds},
};
use tokio::time::Instant;

/// Counts frames/writes that reach the bus, to prove refused requests never do (A-ENG-4).
struct CountingCan<A> {
    inner: A,
    sent: Arc<AtomicUsize>,
}

#[async_trait]
impl<A: VehicleBusAdapter> VehicleBusAdapter for CountingCan<A> {
    async fn open(&mut self, bitrate: u32) -> edge_daemon::hal::Result<()> {
        self.inner.open(bitrate).await
    }
    async fn set_filter(&mut self, filters: &[CanFilter]) -> edge_daemon::hal::Result<()> {
        self.inner.set_filter(filters).await
    }
    async fn send_frame(&mut self, frame: &CanFrame) -> edge_daemon::hal::Result<()> {
        self.sent.fetch_add(1, Ordering::SeqCst);
        self.inner.send_frame(frame).await
    }
    async fn recv_frame(&mut self, timeout: Duration) -> edge_daemon::hal::Result<CanFrame> {
        self.inner.recv_frame(timeout).await
    }
    async fn close(&mut self) -> edge_daemon::hal::Result<()> {
        self.inner.close().await
    }
}

struct CountingKLine<A> {
    inner: A,
    writes: Arc<AtomicUsize>,
}

#[async_trait]
impl<A: KLineAdapter> KLineAdapter for CountingKLine<A> {
    async fn open(&mut self, baud: u32) -> edge_daemon::hal::Result<()> {
        self.inner.open(baud).await
    }
    async fn wake_fast_init(&mut self) -> edge_daemon::hal::Result<()> {
        self.inner.wake_fast_init().await
    }
    async fn wake_5baud(&mut self, addr: u8) -> edge_daemon::hal::Result<KeyBytes> {
        self.inner.wake_5baud(addr).await
    }
    async fn write_bytes(&mut self, bytes: &[u8]) -> edge_daemon::hal::Result<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.inner.write_bytes(bytes).await
    }
    async fn read_bytes(
        &mut self,
        max: usize,
        timeout: Duration,
    ) -> edge_daemon::hal::Result<Vec<u8>> {
        self.inner.read_bytes(max, timeout).await
    }
    async fn close(&mut self) -> edge_daemon::hal::Result<()> {
        self.inner.close().await
    }
}

fn interlock(session: &str) -> (Arc<MemoryAudit>, Arc<SafetyInterlock>) {
    let audit = Arc::new(MemoryAudit::default());
    (
        audit.clone(),
        Arc::new(SafetyInterlock::new(session, audit)),
    )
}

async fn can_channel(
    profile: &str,
    addr: CanAddressing,
    cfg: IsoTpConfig,
    lock: Arc<SafetyInterlock>,
) -> (VirtualBus, Arc<AtomicUsize>, DiagChannel) {
    let bus = VirtualBus::from_profile_id(profile).unwrap();
    let mut adapter = bus.adapter();
    adapter.open(bus.bitrate()).await.unwrap();
    let sent = Arc::new(AtomicUsize::new(0));
    let counting = CountingCan {
        inner: adapter,
        sent: sent.clone(),
    };
    let link = IsoTpLink::new(counting, addr, cfg).await.unwrap();
    (bus, sent, DiagChannel::isotp(link, lock))
}

fn token(ch: &DiagChannel, protocol: DiagProtocol, payload: &[u8]) -> String {
    let (tx, rx) = ch.ids();
    ch.interlock()
        .issue_token(
            &GatedRequest {
                protocol,
                tx,
                rx,
                payload,
            },
            "Technician confirmed the action",
        )
        .expect("token issued")
        .token
}

fn hex_byte(s: &str) -> u8 {
    u8::from_str_radix(s.trim_start_matches("0x"), 16).unwrap()
}

/// A request payload for every gated rule in safety_policy.json.
fn gated_payloads() -> Vec<(DiagProtocol, Vec<u8>)> {
    protocol::safety_policy()
        .gated
        .iter()
        .map(|rule| {
            let protocol: DiagProtocol = rule.protocol.to_string().parse().unwrap();
            let mut payload = vec![hex_byte(&rule.service_id)];
            payload.push(rule.sub_function.as_ref().map_or(0x01, |s| hex_byte(s)));
            payload.extend([0x01, 0x02]);
            (protocol, payload)
        })
        .collect()
}

/// Gate: ISO-TP reassembles > 64 bytes with BlockSize/STmin honoured.
#[tokio::test(start_paused = true)]
async fn isotp_reassembles_large_response_with_block_size() {
    let (_audit, lock) = interlock("s-isotp");
    let cfg = IsoTpConfig {
        block_size: 4,
        st_min: 0x05,
        ..IsoTpConfig::default()
    };
    let addr = CanAddressing::normal(generic_uds::ENGINE_REQ, generic_uds::ENGINE_RESP);
    let (bus, sent, mut ch) = can_channel(generic_uds::ID, addr, cfg, lock).await;
    let mut sniffer = bus.adapter();
    sniffer.open(500_000).await.unwrap();
    sniffer
        .set_filter(&[CanFilter::exact(generic_uds::ENGINE_RESP, false)])
        .await
        .unwrap();

    let started = Instant::now();
    let value = Uds(&mut ch)
        .read_did(generic_uds::DID_CALIBRATION)
        .await
        .unwrap();
    assert_eq!(value, (0..100u8).collect::<Vec<_>>());
    // 103-byte response: FF (6) + 14 CFs; BS 4 -> request SF + 4 Flow Controls.
    assert_eq!(sent.load(Ordering::SeqCst), 5);
    // The ECU paced CFs at our 5 ms STmin: 14 CFs, at least 10 gaps of 5 ms inside blocks.
    assert!(Instant::now() - started >= Duration::from_millis(50));
    let mut cf_times = Vec::new();
    while let Ok(frame) = sniffer.recv_frame(Duration::from_millis(1)).await {
        if frame.data()[0] >> 4 == 0x2 {
            cf_times.push(frame);
        }
    }
    assert_eq!(cf_times.len(), 14);
}

/// Gate: KWP2000 fast init + 0x1A on the virtual pre-03/2007 E90 DME.
#[tokio::test(start_paused = true)]
async fn kwp2000_fast_init_and_identification_on_e90_dme() {
    let (_audit, lock) = interlock("s-kline");
    let mut adapter = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
    adapter.open(10_400).await.unwrap();
    let (link, kb) = KLineLink::connect_fast(adapter, e90_pre2007::DME, Timing::KLINE)
        .await
        .unwrap();
    assert_eq!(
        kb,
        KeyBytes {
            kb1: 0xEF,
            kb2: 0x8F
        }
    );
    let mut ch = DiagChannel::kline(link, lock);
    let ident = Kwp(&mut ch).read_ecu_identification(0x80).await.unwrap();
    assert_eq!(String::from_utf8_lossy(&ident), "7558091 MSV70 E90 N52");
    let dtcs = Kwp(&mut ch).read_dtcs(0x02).await.unwrap();
    assert_eq!(dtcs[0].code, 0x2A82);
    Kwp(&mut ch).tester_present().await.unwrap();
}

/// Gate: BMW D-CAN extended addressing round trip on the 03/2007+ E90 DME.
#[tokio::test(start_paused = true)]
async fn bmw_dcan_extended_addressing_round_trip() {
    let (_audit, lock) = interlock("s-dcan");
    let addr = CanAddressing::BmwExtended {
        ecu: e90_pre2007::DME,
    };
    let (_bus, _sent, mut ch) = can_channel(
        e90_dcan::ID,
        addr,
        IsoTpConfig {
            pad: Some(0xFF),
            ..IsoTpConfig::default()
        },
        lock.clone(),
    )
    .await;
    let ident = Kwp(&mut ch).read_ecu_identification(0x80).await.unwrap();
    assert!(String::from_utf8_lossy(&ident).contains("MSV70"));
    // The DSC at 0x29 on the same profile answers on 0x629.
    let (_bus, _sent, mut dsc) = can_channel(
        e90_dcan::ID,
        CanAddressing::BmwExtended {
            ecu: e90_pre2007::DSC,
        },
        IsoTpConfig::default(),
        lock,
    )
    .await;
    assert_eq!(Kwp(&mut dsc).read_dtcs(0x02).await.unwrap()[0].code, 0x5DF6);
}

/// Gate + A-ENG-4: every gated service is refused in SILENT on every transport,
/// and nothing reaches the bus.
#[tokio::test(start_paused = true)]
async fn every_gated_service_refused_in_silent_on_every_transport() {
    let payloads = gated_payloads();

    // CAN / ISO-TP.
    let (audit, lock) = interlock("s-silent");
    lock.update_speed(0.0);
    let addr = CanAddressing::normal(generic_uds::ENGINE_REQ, generic_uds::ENGINE_RESP);
    let (_bus, sent, mut can) =
        can_channel(generic_uds::ID, addr, IsoTpConfig::default(), lock.clone()).await;

    // K-line (after the ungated StartCommunication).
    let writes = Arc::new(AtomicUsize::new(0));
    let mut kadapter = CountingKLine {
        inner: VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap(),
        writes: writes.clone(),
    };
    kadapter.open(10_400).await.unwrap();
    let (klink, _) = KLineLink::connect_fast(kadapter, e90_pre2007::DME, Timing::KLINE)
        .await
        .unwrap();
    let writes_after_init = writes.load(Ordering::SeqCst);
    let mut kline = DiagChannel::kline(klink, lock.clone());

    // STN/ELM K-line: the recording holds only the init, so any write would fail as a mismatch.
    let init = include_str!("../fixtures/hal/stn2120_kline.txt");
    let init_only: String = init
        .lines()
        .take_while(|l| !l.starts_with("> ATSP5"))
        .chain(["> ATSP5\\r", "< OK\\r\\r>"])
        .collect::<Vec<_>>()
        .join("\n");
    let mut stn = StnElmAdapter::new(
        ReplaySerial::from_script(&init_only).unwrap(),
        StnProtocol::KwpFast,
    );
    stn.init().await.unwrap();
    let mut elm = DiagChannel::elm(ElmKLineLink::new(stn, e90_pre2007::DME), lock.clone());

    for (protocol, payload) in &payloads {
        for (name, ch) in [
            ("isotp", &mut can),
            ("kline", &mut kline),
            ("elm", &mut elm),
        ] {
            let req = DiagRequest {
                protocol: *protocol,
                payload,
                safety_token: Some("st_forged_token"),
            };
            match ch.request(req).await {
                Err(DiagError::Refused(r)) => {
                    assert_eq!(r.code, RefusalCode::SafetyBlocked, "{name} {payload:02X?}")
                }
                other => panic!("{name} {payload:02X?} was not refused: {other:?}"),
            }
        }
    }
    assert_eq!(sent.load(Ordering::SeqCst), 0, "no CAN frame sent");
    assert_eq!(
        writes.load(Ordering::SeqCst),
        writes_after_init,
        "no K-line byte sent"
    );
    let refused = audit
        .entries()
        .iter()
        .filter(|e| e.outcome == Outcome::Refused)
        .count();
    assert_eq!(refused, payloads.len() * 3, "every attempt audited");

    // Ungated reads still work in SILENT.
    assert_eq!(Obd(&mut can).read_vin().await.unwrap(), "1HGCM82633A004352");
}

/// Gate: SecurityAccess halted after NRC 0x35, and after 0x36/0x37 with the delay reported.
#[tokio::test(start_paused = true)]
async fn security_access_halts_end_to_end() {
    let (audit, lock) = interlock("s-security");
    lock.set_mode(SafetyMode::ActiveConfirmed);
    let addr = CanAddressing::normal(falcon_ba::PCM.0, falcon_ba::PCM.1);
    let (_bus, sent, mut ch) =
        can_channel(falcon_ba::ID, addr, IsoTpConfig::default(), lock.clone()).await;
    Uds(&mut ch)
        .session_control(SESSION_EXTENDED, None)
        .await
        .unwrap();

    let wrong_key = async |ch: &mut DiagChannel| {
        lock.update_speed(0.0);
        let t = token(ch, DiagProtocol::Uds, &[0x27, 0x01]);
        let seed = Uds(ch).request_seed(0x01, Some(&t)).await?;
        let key = vec![0u8; seed.len()];
        let mut req = vec![0x27, 0x02];
        req.extend(&key);
        let t = token(ch, DiagProtocol::Uds, &req);
        Uds(ch).send_key(0x01, &key, Some(&t)).await
    };

    // First wrong key: NRC 0x35, SecurityAccess halted for the session.
    assert!(matches!(
        wrong_key(&mut ch).await,
        Err(DiagError::Negative { nrc: 0x35, .. })
    ));
    let before = sent.load(Ordering::SeqCst);
    let refusal = lock
        .issue_token(
            &GatedRequest {
                protocol: DiagProtocol::Uds,
                tx: 0x7E0,
                rx: 0x7E8,
                payload: &[0x27, 0x01],
            },
            "ack",
        )
        .unwrap_err();
    assert_eq!(
        (refusal.code, refusal.retry_after),
        (RefusalCode::SafetyBlocked, None)
    );
    match ch
        .request(DiagRequest {
            protocol: DiagProtocol::Uds,
            payload: &[0x27, 0x01],
            safety_token: None,
        })
        .await
    {
        Err(DiagError::Refused(r)) => assert!(r.message.contains("0x35"), "{r}"),
        other => panic!("not halted: {other:?}"),
    }
    assert_eq!(
        sent.load(Ordering::SeqCst),
        before,
        "halted request never sent"
    );

    // A new session: the PCM's second wrong key exceeds its attempts (NRC 0x36).
    lock.end_session();
    lock.set_mode(SafetyMode::ActiveConfirmed);
    assert!(matches!(
        wrong_key(&mut ch).await,
        Err(DiagError::Negative { nrc: 0x36, .. })
    ));
    let refusal = lock
        .issue_token(
            &GatedRequest {
                protocol: DiagProtocol::Uds,
                tx: 0x7E0,
                rx: 0x7E8,
                payload: &[0x27, 0x01],
            },
            "ack",
        )
        .unwrap_err();
    assert!(refusal.retry_after.is_some(), "delay reported after 0x36");

    // Another new session while the ECU is still locked out: NRC 0x37 on requestSeed.
    lock.end_session();
    lock.set_mode(SafetyMode::ActiveConfirmed);
    lock.update_speed(0.0);
    let t = token(&ch, DiagProtocol::Uds, &[0x27, 0x01]);
    assert!(matches!(
        Uds(&mut ch).request_seed(0x01, Some(&t)).await,
        Err(DiagError::Negative { nrc: 0x37, .. })
    ));
    let refusal = lock
        .issue_token(
            &GatedRequest {
                protocol: DiagProtocol::Uds,
                tx: 0x7E0,
                rx: 0x7E8,
                payload: &[0x27, 0x01],
            },
            "ack",
        )
        .unwrap_err();
    assert!(refusal.retry_after.is_some(), "delay reported after 0x37");

    let nrcs: Vec<u8> = audit
        .entries()
        .iter()
        .filter(|e| e.outcome == Outcome::Response)
        .filter_map(|e| e.nrc)
        .collect();
    assert_eq!(
        nrcs,
        vec![0x35, 0x36, 0x37],
        "every gated result audited with its NRC"
    );
}

/// Gate: NRC 0x78 then a positive response succeeds (P2* wait), after a proper unlock.
#[tokio::test(start_paused = true)]
async fn response_pending_then_positive_succeeds() {
    let (audit, lock) = interlock("s-pending");
    lock.set_mode(SafetyMode::ActiveConfirmed);
    let addr = CanAddressing::normal(generic_uds::ENGINE_REQ, generic_uds::ENGINE_RESP);
    let (_bus, _sent, mut ch) =
        can_channel(generic_uds::ID, addr, IsoTpConfig::default(), lock.clone()).await;
    Uds(&mut ch)
        .session_control(SESSION_EXTENDED, None)
        .await
        .unwrap();

    lock.update_speed(0.0);
    let t = token(&ch, DiagProtocol::Uds, &[0x27, 0x01]);
    let seed = Uds(&mut ch).request_seed(0x01, Some(&t)).await.unwrap();
    let key = generic_uds::key(&seed);
    let mut req = vec![0x27, 0x02];
    req.extend(&key);
    let t = token(&ch, DiagProtocol::Uds, &req);
    Uds(&mut ch).send_key(0x01, &key, Some(&t)).await.unwrap();

    // RoutineControl: the ECU answers 7F 31 78 at P2, then 71 01 02 03 00 later than P2 (50 ms).
    let rid = generic_uds::ROUTINE_CHECK_PRECONDITIONS;
    let payload = [0x31, 0x01, (rid >> 8) as u8, rid as u8];
    let t = token(&ch, DiagProtocol::Uds, &payload);
    let started = Instant::now();
    let status = Uds(&mut ch)
        .routine_control(0x01, rid, &[], Some(&t))
        .await
        .unwrap();
    assert_eq!(status, vec![0x00]);
    assert!(
        Instant::now() - started > Timing::CAN.p2,
        "answer arrived after P2, within P2*"
    );

    // Gated I/O control with a token for a different payload is refused before sending.
    let wrong = token(&ch, DiagProtocol::Uds, &[0x2F, 0x0B, 0x2A, 0x03, 0x00]);
    match Uds(&mut ch)
        .io_control(generic_uds::IO_IDLE_ACTUATOR, 0x03, &[0x01], Some(&wrong))
        .await
    {
        Err(DiagError::Refused(r)) => assert_eq!(r.code, RefusalCode::TokenInvalid),
        other => panic!("{other:?}"),
    }
    let allowed = audit
        .entries()
        .iter()
        .filter(|e| e.outcome == Outcome::Allowed)
        .count();
    assert_eq!(allowed, 3, "seed, key and routine were allowed and audited");
}

#[tokio::test(start_paused = true)]
async fn obd_reads_and_gated_clear() {
    let (_audit, lock) = interlock("s-obd");
    let addr = CanAddressing::obd_functional(falcon_ba::PCM.1);
    let (bus, _sent, mut ch) =
        can_channel(falcon_ba::ID, addr, IsoTpConfig::default(), lock.clone()).await;
    bus.with_vehicle(|v| {
        v.rpm = 812.5;
        v.ect_c = 88.0;
    });
    let values = Obd(&mut ch).read_pids(&[0x0C, 0x05]).await.unwrap();
    assert_eq!((values[0].value, values[1].value), (812.5, 88.0));
    // Six PIDs need a multi-frame answer: Flow Control must go to the PCM's
    // physical id (0x7E0), not the functional 0x7DF (ISO 15765-4).
    let six = Obd(&mut ch)
        .read_pids(&[0x0C, 0x0D, 0x05, 0x06, 0x07, 0x42])
        .await
        .unwrap();
    assert_eq!(six.len(), 6);
    let supported = Obd(&mut ch).supported_pids().await.unwrap();
    assert!(
        supported.contains(&0x0C) && supported.contains(&0x42),
        "{supported:02X?}"
    );
    assert_eq!(Obd(&mut ch).read_dtcs(0x03).await.unwrap(), vec!["P0171"]);
    assert_eq!(Obd(&mut ch).read_dtcs(0x07).await.unwrap(), vec!["P0174"]);
    // Mode 0x04 is gated (Tier A).
    assert!(matches!(
        Obd(&mut ch).clear_dtcs(None).await,
        Err(DiagError::Refused(_))
    ));
    lock.set_mode(SafetyMode::ActiveConfirmed);
    lock.update_speed(0.0);
    let t = token(&ch, DiagProtocol::Obd, &[0x04]);
    Obd(&mut ch).clear_dtcs(Some(&t)).await.unwrap();
    assert!(Obd(&mut ch).read_dtcs(0x03).await.unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn suppressed_positive_response_and_timeout() {
    let (_audit, lock) = interlock("s-misc");
    let addr = CanAddressing::normal(generic_uds::ENGINE_REQ, generic_uds::ENGINE_RESP);
    let (_bus, _sent, mut ch) =
        can_channel(generic_uds::ID, addr, IsoTpConfig::default(), lock.clone()).await;
    Uds(&mut ch).tester_present(true).await.unwrap();
    // No ECU at this address: a plain timeout, not a hang.
    let (_bus, _sent, mut nobody) = can_channel(
        generic_uds::ID,
        CanAddressing::normal(0x7E1, 0x7E9),
        IsoTpConfig::default(),
        lock,
    )
    .await;
    assert!(matches!(
        Uds(&mut nobody).read_did(0xF190).await,
        Err(DiagError::Hal(edge_daemon::hal::HalError::Timeout(_)))
    ));
}
