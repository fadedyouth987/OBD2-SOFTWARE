//! In-memory K-line with simulated KWP2000 ECUs (Task 1.1).
//!
//! Models what makes K-line awkward on real cars:
//! - ECUs sleep until a wake-up: fast init (25 ms low, 25 ms high, then
//!   StartCommunication 0x81) or 5-baud init (~2 s address byte, key bytes).
//! - Half-duplex, one ECU session at a time (A-ENG-2): after waking the DME,
//!   requests to the DSC are ignored until the tester re-initializes.
//! - P3: the session ends after 5 s without a request.
//! - Messages use ISO 14230-2 framing with a checksum; corrupt bytes are ignored.
//!
//! The echo a real K-line cable produces is not exposed, matching the
//! [`KLineAdapter`] contract.

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use async_trait::async_trait;
use tokio::time::Instant;

use super::{HalError, KLineAdapter, KeyBytes, Result};
use crate::sim::{
    ecu::EcuSim,
    kline_peer::{self, KFrame, Parsed},
    profiles::{self, Link, Profile, KLINE_OBD_FUNCTIONAL, KLINE_TESTER_ADDR},
    VehicleState,
};

/// P3max: a session ends after this long without tester activity.
const P3_MAX_MS: u64 = 5_000;
/// Fast init: TiniL + TiniH.
const FAST_INIT: Duration = Duration::from_millis(50);
/// 5-baud init: 10 bits at 5 baud, plus W1 before the sync byte.
const FIVE_BAUD_INIT: Duration = Duration::from_millis(2_060);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Line {
    Asleep,
    /// Fast-init pattern seen; waiting for StartCommunication.
    AwaitingStart,
    /// In a session with ECU `idx`.
    Session(usize),
}

struct KState {
    start: Instant,
    ecus: Vec<(EcuSim, u8)>,
    vehicle: VehicleState,
    line: Line,
    rx: Vec<u8>,
    /// ECU bytes and the time (µs) they become readable.
    out: VecDeque<(u64, u8)>,
    last_activity_us: u64,
    open_baud: Option<u32>,
}

impl KState {
    fn now_us(&self) -> u64 {
        Instant::now().duration_since(self.start).as_micros() as u64
    }

    fn expire_session(&mut self, now_us: u64) {
        if let Line::Session(idx) = self.line {
            if now_us.saturating_sub(self.last_activity_us) > P3_MAX_MS * 1_000 {
                self.ecus[idx].0.reset_session();
                self.line = Line::Asleep;
            }
        }
    }

    fn queue_reply(&mut self, at_us: u64, ecu_addr: u8, data: Vec<u8>) {
        let bytes = kline_peer::build(&KFrame {
            functional: false,
            target: KLINE_TESTER_ADDR,
            source: ecu_addr,
            data,
        });
        for b in bytes {
            self.out.push_back((at_us, b));
        }
        self.last_activity_us = self.last_activity_us.max(at_us);
    }

    fn on_frame(&mut self, now_us: u64, frame: KFrame) {
        let now_ms = now_us / 1_000;
        let idx = match self.line {
            Line::Asleep => return, // nobody is listening
            Line::AwaitingStart => {
                if frame.data.first() != Some(&0x81) {
                    return;
                }
                match self.ecus.iter().position(|(_, addr)| *addr == frame.target) {
                    Some(idx) => {
                        self.line = Line::Session(idx);
                        idx
                    }
                    None => return,
                }
            }
            Line::Session(idx) => {
                let addr = self.ecus[idx].1;
                let obd = frame.functional
                    && frame.target == KLINE_OBD_FUNCTIONAL
                    && self.ecus[idx].0.spec.obd;
                if frame.target != addr && !obd {
                    return; // one session at a time (A-ENG-2)
                }
                idx
            }
        };
        let addr = self.ecus[idx].1;
        let stop = frame.data.first() == Some(&0x82);
        let replies = self.ecus[idx]
            .0
            .handle(now_ms, &frame.data, &mut self.vehicle);
        for reply in replies {
            self.queue_reply(now_us + reply.delay_ms * 1_000, addr, reply.data);
        }
        if stop {
            self.line = Line::Asleep;
        }
    }
}

/// A virtual K-line vehicle and the one tester on it.
pub struct VirtualKLineAdapter {
    state: Arc<Mutex<KState>>,
}

/// Shared handle for tests to change the vehicle while an adapter is in use.
#[derive(Clone)]
pub struct VirtualKLineHandle {
    state: Arc<Mutex<KState>>,
}

impl VirtualKLineHandle {
    pub fn with_vehicle<T>(&self, f: impl FnOnce(&mut VehicleState) -> T) -> T {
        f(&mut self.state.lock().expect("k-line lock").vehicle)
    }

    pub fn with_ecu<T>(&self, name: &str, f: impl FnOnce(&mut EcuSim) -> T) -> Option<T> {
        let mut state = self.state.lock().expect("k-line lock");
        state
            .ecus
            .iter_mut()
            .find(|(e, _)| e.name() == name)
            .map(|(e, _)| f(e))
    }
}

impl VirtualKLineAdapter {
    pub fn new(profile: Profile) -> Result<Self> {
        let Link::KLine { .. } = profile.link else {
            return Err(HalError::Unsupported(format!(
                "{} is a CAN vehicle; use VirtualBus",
                profile.id
            )));
        };
        let ecus = profile
            .ecus
            .into_iter()
            .filter_map(|n| n.kline.map(|addr| (EcuSim::new(n.spec), addr)))
            .collect();
        Ok(Self {
            state: Arc::new(Mutex::new(KState {
                start: Instant::now(),
                ecus,
                vehicle: profile.vehicle,
                line: Line::Asleep,
                rx: Vec::new(),
                out: VecDeque::new(),
                last_activity_us: 0,
                open_baud: None,
            })),
        })
    }

    pub fn from_profile_id(id: &str) -> Result<Self> {
        let profile = profiles::by_id(id)
            .ok_or_else(|| HalError::Unsupported(format!("unknown profile {id}")))?;
        Self::new(profile)
    }

    pub fn handle(&self) -> VirtualKLineHandle {
        VirtualKLineHandle {
            state: Arc::clone(&self.state),
        }
    }

    fn lock(&self) -> MutexGuard<'_, KState> {
        self.state.lock().expect("k-line lock poisoned")
    }

    fn require_open(&self) -> Result<()> {
        self.lock().open_baud.map(|_| ()).ok_or(HalError::NotOpen)
    }
}

#[async_trait]
impl KLineAdapter for VirtualKLineAdapter {
    async fn open(&mut self, baud: u32) -> Result<()> {
        if !(9_600..=10_400).contains(&baud) {
            return Err(HalError::Unsupported(format!("K-line at {baud} baud")));
        }
        self.lock().open_baud = Some(baud);
        Ok(())
    }

    async fn wake_fast_init(&mut self) -> Result<()> {
        self.require_open()?;
        tokio::time::sleep(FAST_INIT).await;
        let mut s = self.lock();
        if let Line::Session(idx) = s.line {
            s.ecus[idx].0.reset_session();
        }
        s.line = Line::AwaitingStart;
        s.rx.clear();
        s.out.clear();
        s.last_activity_us = s.now_us();
        Ok(())
    }

    async fn wake_5baud(&mut self, addr: u8) -> Result<KeyBytes> {
        self.require_open()?;
        tokio::time::sleep(FIVE_BAUD_INIT).await;
        let mut s = self.lock();
        if let Line::Session(idx) = s.line {
            s.ecus[idx].0.reset_session();
        }
        s.rx.clear();
        s.out.clear();
        let Some(idx) = s.ecus.iter().position(|(_, a)| *a == addr) else {
            s.line = Line::Asleep;
            return Err(HalError::Timeout(FIVE_BAUD_INIT)); // no sync byte
        };
        s.line = Line::Session(idx);
        s.last_activity_us = s.now_us();
        let (kb1, kb2) = s.ecus[idx].0.spec.key_bytes;
        Ok(KeyBytes { kb1, kb2 })
    }

    async fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        self.require_open()?;
        let mut s = self.lock();
        let now = s.now_us();
        s.expire_session(now);
        s.last_activity_us = now;
        s.rx.extend_from_slice(bytes);
        loop {
            match kline_peer::parse(&s.rx) {
                Parsed::Frame(frame, used) => {
                    s.rx.drain(..used);
                    s.on_frame(now, frame);
                }
                Parsed::Invalid => {
                    s.rx.remove(0);
                }
                Parsed::Incomplete => break,
            }
        }
        Ok(())
    }

    async fn read_bytes(&mut self, max: usize, timeout: Duration) -> Result<Vec<u8>> {
        self.require_open()?;
        let deadline = Instant::now() + timeout;
        loop {
            let next_due = {
                let mut s = self.lock();
                let now = s.now_us();
                s.expire_session(now);
                let mut got = Vec::new();
                while got.len() < max {
                    match s.out.front() {
                        Some(&(due, b)) if due <= now => {
                            got.push(b);
                            s.out.pop_front();
                        }
                        _ => break,
                    }
                }
                if !got.is_empty() {
                    return Ok(got);
                }
                s.out
                    .front()
                    .map(|&(due, _)| s.start + Duration::from_micros(due))
            };
            if Instant::now() >= deadline {
                return Err(HalError::Timeout(timeout));
            }
            tokio::time::sleep_until(next_due.map_or(deadline, |due| due.min(deadline))).await;
        }
    }

    async fn close(&mut self) -> Result<()> {
        let mut s = self.lock();
        s.open_baud = None;
        s.line = Line::Asleep;
        s.out.clear();
        s.rx.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::profiles::e90_pre2007::{self, CAS, DME};

    const T: Duration = Duration::from_millis(500);

    fn request(target: u8, data: &[u8]) -> Vec<u8> {
        kline_peer::build(&KFrame {
            functional: false,
            target,
            source: KLINE_TESTER_ADDR,
            data: data.to_vec(),
        })
    }

    /// Reads one complete ISO 14230 message from the adapter.
    async fn read_frame(k: &mut VirtualKLineAdapter) -> KFrame {
        let mut buf = Vec::new();
        loop {
            buf.extend(k.read_bytes(64, T).await.expect("ECU reply"));
            if let Parsed::Frame(frame, _) = kline_peer::parse(&buf) {
                return frame;
            }
        }
    }

    async fn awake(k: &mut VirtualKLineAdapter, target: u8) {
        k.open(10_400).await.unwrap();
        k.wake_fast_init().await.unwrap();
        k.write_bytes(&request(target, &[0x81])).await.unwrap();
        assert_eq!(read_frame(k).await.data, vec![0xC1, 0xEF, 0x8F]);
    }

    /// Task 1.1 gate: fast init + StartCommunication, then a byte round trip.
    #[tokio::test(start_paused = true)]
    async fn fast_init_and_byte_round_trip() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        k.open(10_400).await.unwrap();
        let t0 = Instant::now();
        k.wake_fast_init().await.unwrap();
        assert!(
            Instant::now() - t0 >= Duration::from_millis(50),
            "25 ms low + 25 ms high"
        );
        k.write_bytes(&[0x81, 0x12, 0xF1, 0x81, 0x05])
            .await
            .unwrap();
        // Raw bytes on the line: format, target, source, C1 EF 8F, checksum.
        let mut raw = Vec::new();
        while raw.len() < 7 {
            raw.extend(k.read_bytes(16, T).await.unwrap());
        }
        assert_eq!(raw, vec![0x83, 0xF1, 0x12, 0xC1, 0xEF, 0x8F, 0xC5]);

        // ReadECUIdentification, written in two pieces as a slow UART might.
        let req = request(DME, &[0x1A, 0x80]);
        k.write_bytes(&req[..2]).await.unwrap();
        k.write_bytes(&req[2..]).await.unwrap();
        let reply = read_frame(&mut k).await;
        assert_eq!((reply.source, reply.target), (DME, KLINE_TESTER_ADDR));
        assert_eq!(&reply.data[..2], &[0x5A, 0x80]);
        assert!(reply.data.ends_with(b"MSV70 E90 N52"));
    }

    #[tokio::test(start_paused = true)]
    async fn asleep_ecus_ignore_requests() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        k.open(10_400).await.unwrap();
        k.write_bytes(&request(DME, &[0x81])).await.unwrap();
        assert!(matches!(
            k.read_bytes(16, T).await,
            Err(HalError::Timeout(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn one_session_at_a_time() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        awake(&mut k, DME).await;
        // The CAS does not answer while the DME holds the line.
        k.write_bytes(&request(CAS, &[0x1A, 0x80])).await.unwrap();
        assert!(k.read_bytes(16, T).await.is_err());
        // Re-initialize to talk to the CAS.
        k.wake_fast_init().await.unwrap();
        k.write_bytes(&request(CAS, &[0x81])).await.unwrap();
        assert_eq!(read_frame(&mut k).await.source, CAS);
    }

    #[tokio::test(start_paused = true)]
    async fn p3_timeout_ends_the_session() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        awake(&mut k, DME).await;
        tokio::time::sleep(Duration::from_secs(6)).await;
        k.write_bytes(&request(DME, &[0x3E])).await.unwrap();
        assert!(k.read_bytes(16, T).await.is_err(), "ECU went back to sleep");
    }

    #[tokio::test(start_paused = true)]
    async fn five_baud_init_returns_key_bytes() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        k.open(10_400).await.unwrap();
        let t0 = Instant::now();
        assert_eq!(
            k.wake_5baud(DME).await.unwrap(),
            KeyBytes {
                kb1: 0xEF,
                kb2: 0x8F
            }
        );
        assert!(Instant::now() - t0 >= Duration::from_secs(2));
        k.write_bytes(&request(DME, &[0x3E])).await.unwrap();
        assert_eq!(read_frame(&mut k).await.data, vec![0x7E]);
        assert!(k.wake_5baud(0x77).await.is_err(), "no ECU at that address");
    }

    #[tokio::test(start_paused = true)]
    async fn functional_obd_and_corrupt_bytes() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        awake(&mut k, DME).await;
        k.handle().with_vehicle(|v| v.speed_kmh = 0.0);
        // Garbage, then a functional OBD request for PID 0x0D (speed).
        let obd = kline_peer::build(&KFrame {
            functional: true,
            target: KLINE_OBD_FUNCTIONAL,
            source: KLINE_TESTER_ADDR,
            data: vec![0x01, 0x0D],
        });
        let mut bytes = vec![0x00, 0x13];
        bytes.extend(obd);
        k.write_bytes(&bytes).await.unwrap();
        assert_eq!(read_frame(&mut k).await.data, vec![0x41, 0x0D, 0x00]);
    }

    #[tokio::test(start_paused = true)]
    async fn slow_service_sends_response_pending() {
        let mut k = VirtualKLineAdapter::from_profile_id(e90_pre2007::ID).unwrap();
        awake(&mut k, DME).await;
        k.write_bytes(&request(DME, &[0x14, 0xFF, 0x00]))
            .await
            .unwrap();
        assert_eq!(read_frame(&mut k).await.data, vec![0x7F, 0x14, 0x78]);
        assert_eq!(read_frame(&mut k).await.data, vec![0x54, 0xFF, 0x00]);
    }
}
