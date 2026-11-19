//! In-memory CAN bus with simulated ECUs (Task 1.1).
//!
//! A [`VirtualBus`] holds one virtual vehicle. Any number of
//! [`VirtualBusAdapter`]s attach to it, like several tools on one OBD port:
//! a frame one adapter sends reaches every other open adapter (not the
//! sender, matching SocketCAN defaults) and the simulated ECUs, whose replies
//! arrive after realistic delays through ECU-side ISO-TP.
//!
//! Time comes from `tokio::time`, so tests can pause the clock and run
//! deterministically. Opening an adapter at the wrong bitrate behaves like a
//! real bus: sends fail (no acknowledgement) and nothing is received.

use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use async_trait::async_trait;
use tokio::{sync::Notify, time::Instant};

use super::{passes, CanFilter, CanFrame, HalError, Result, VehicleBusAdapter};
use crate::sim::{
    ecu::EcuSim,
    isotp_peer::IsoTpPeer,
    profiles::{self, CanAddr, Link, PeriodicFrame, Profile},
    VehicleState,
};

/// Frames an adapter can buffer before the oldest are dropped (like a controller overrun).
const INBOX_LIMIT: usize = 10_000;
/// ECU turnaround for transport-level frames (Flow Control, Consecutive Frames).
const TRANSPORT_LATENCY_US: u64 = 400;
/// S3: a non-default session ends after this long without a request.
const S3_TIMEOUT_MS: u64 = 5_000;

struct NodeLink {
    addr: CanAddr,
    /// Index into `Node::peers` (a Functional link shares its physical peer).
    peer: usize,
}

struct Node {
    ecu: EcuSim,
    links: Vec<NodeLink>,
    peers: Vec<(u32, IsoTpPeer)>,
    last_request_ms: u64,
}

struct Port {
    open: bool,
    filters: Vec<CanFilter>,
    /// Frames keyed by (due time µs, sequence).
    inbox: BTreeMap<(u64, u64), CanFrame>,
    notify: Arc<Notify>,
}

struct Periodic {
    spec: PeriodicFrame,
    next_due_us: u64,
    counter: u32,
}

struct BusInner {
    start: Instant,
    bitrate: u32,
    nodes: Vec<Node>,
    vehicle: VehicleState,
    periodic: Vec<Periodic>,
    ports: Vec<Port>,
    seq: u64,
}

/// A virtual vehicle's CAN bus. Cheap to clone; clones share the bus.
#[derive(Clone)]
pub struct VirtualBus {
    inner: Arc<Mutex<BusInner>>,
}

impl BusInner {
    fn now_us(&self) -> u64 {
        Instant::now().duration_since(self.start).as_micros() as u64
    }

    fn deliver(&mut self, due_us: u64, frame: &CanFrame, except: Option<usize>) {
        for (i, port) in self.ports.iter_mut().enumerate() {
            if Some(i) == except || !port.open || !passes(&port.filters, frame) {
                continue;
            }
            self.seq += 1;
            port.inbox.insert((due_us, self.seq), frame.clone());
            if port.inbox.len() > INBOX_LIMIT {
                port.inbox.pop_first();
            }
            port.notify.notify_one();
        }
    }

    /// Generates periodic broadcast frames up to `now_us`.
    fn pump(&mut self, now_us: u64) {
        let any_open = self.ports.iter().any(|p| p.open);
        for i in 0..self.periodic.len() {
            let period = self.periodic[i].spec.period_ms * 1_000;
            // Keep at most one second of backlog after a long clock jump.
            if now_us > self.periodic[i].next_due_us + 1_000_000 {
                let behind = now_us - 1_000_000 - self.periodic[i].next_due_us;
                self.periodic[i].next_due_us += behind.div_ceil(period) * period;
            }
            while self.periodic[i].next_due_us <= now_us {
                let p = &mut self.periodic[i];
                let (due, counter) = (p.next_due_us, p.counter);
                p.next_due_us += period;
                p.counter = p.counter.wrapping_add(1);
                if any_open {
                    let payload = (p.spec.payload)(&self.vehicle, counter);
                    if let Ok(frame) = CanFrame::new(p.spec.id, p.spec.extended, &payload) {
                        self.deliver(due, &frame, None);
                    }
                }
            }
        }
    }

    fn next_periodic_due(&self) -> Option<u64> {
        self.periodic.iter().map(|p| p.next_due_us).min()
    }

    /// Routes a tester frame to the simulated ECUs and schedules their replies.
    fn route_to_ecus(&mut self, now_us: u64, frame: &CanFrame) {
        let now_ms = now_us / 1_000;
        let mut scheduled: Vec<(u64, CanFrame)> = Vec::new();
        for node in &mut self.nodes {
            for link_idx in 0..node.links.len() {
                let addr = node.links[link_idx].addr;
                let pdu: &[u8] = match addr {
                    CanAddr::Normal { req, .. } if !frame.is_extended() && frame.id() == req => {
                        frame.data()
                    }
                    CanAddr::Functional { .. }
                        if !frame.is_extended() && frame.id() == profiles::OBD_FUNCTIONAL_ID =>
                    {
                        // Functional requests are Single Frames only (ISO 15765-4).
                        match frame.data().first() {
                            Some(pci) if pci >> 4 == 0 => frame.data(),
                            _ => continue,
                        }
                    }
                    CanAddr::BmwExtended { ecu }
                        if !frame.is_extended()
                            && frame.id() == profiles::BMW_TESTER_ID
                            && frame.data().first() == Some(&ecu) =>
                    {
                        &frame.data()[1..]
                    }
                    _ => continue,
                };
                let peer_idx = node.links[link_idx].peer;
                let resp_id = node.peers[peer_idx].0;
                let (request, transport) = node.peers[peer_idx].1.on_frame(pdu);
                for out in transport {
                    scheduled.push((
                        now_us + TRANSPORT_LATENCY_US + out.at_us,
                        CanFrame::std(resp_id, &out.payload),
                    ));
                }
                let Some(request) = request else { continue };
                if node.ecu.session() != crate::sim::ecu::Session::Default
                    && now_ms.saturating_sub(node.last_request_ms) > S3_TIMEOUT_MS
                {
                    node.ecu.reset_session();
                }
                node.last_request_ms = now_ms;
                for reply in node.ecu.handle(now_ms, &request, &mut self.vehicle) {
                    let first = node.peers[peer_idx].1.send(&reply.data);
                    scheduled.push((
                        now_us + reply.delay_ms * 1_000,
                        CanFrame::std(resp_id, &first.payload),
                    ));
                }
            }
        }
        for (due, frame) in scheduled {
            self.deliver(due, &frame, None);
        }
    }
}

impl VirtualBus {
    /// Builds a bus for a CAN profile.
    pub fn new(profile: Profile) -> Result<Self> {
        let Link::Can { bitrate } = profile.link else {
            return Err(HalError::Unsupported(format!(
                "{} is a K-line vehicle; use VirtualKLineAdapter",
                profile.id
            )));
        };
        let nodes = profile
            .ecus
            .into_iter()
            .map(|node| {
                let mut peers: Vec<(u32, IsoTpPeer)> = Vec::new();
                let mut peer_for = |resp: u32, prefix: Option<u8>| {
                    peers
                        .iter()
                        .position(|(id, _)| *id == resp)
                        .unwrap_or_else(|| {
                            peers.push((resp, IsoTpPeer::new(prefix, profile.isotp_pad)));
                            peers.len() - 1
                        })
                };
                let links = node
                    .can
                    .iter()
                    .map(|&addr| {
                        let peer = match addr {
                            CanAddr::Normal { resp, .. } | CanAddr::Functional { resp } => {
                                peer_for(resp, None)
                            }
                            CanAddr::BmwExtended { ecu } => peer_for(
                                profiles::BMW_RESPONSE_BASE + u32::from(ecu),
                                Some(profiles::BMW_TESTER_ADDR),
                            ),
                        };
                        NodeLink { addr, peer }
                    })
                    .collect();
                Node {
                    ecu: EcuSim::new(node.spec),
                    links,
                    peers,
                    last_request_ms: 0,
                }
            })
            .collect();
        let periodic = profile
            .periodic
            .into_iter()
            .map(|spec| Periodic {
                next_due_us: spec.period_ms * 1_000,
                spec,
                counter: 0,
            })
            .collect();
        Ok(Self {
            inner: Arc::new(Mutex::new(BusInner {
                start: Instant::now(),
                bitrate,
                nodes,
                vehicle: profile.vehicle,
                periodic,
                ports: Vec::new(),
                seq: 0,
            })),
        })
    }

    /// Builds a bus for a built-in profile id.
    pub fn from_profile_id(id: &str) -> Result<Self> {
        let profile = profiles::by_id(id)
            .ok_or_else(|| HalError::Unsupported(format!("unknown profile {id}")))?;
        Self::new(profile)
    }

    fn lock(&self) -> MutexGuard<'_, BusInner> {
        self.inner.lock().expect("virtual bus lock poisoned")
    }

    /// A new adapter attached to this bus (closed until `open`).
    pub fn adapter(&self) -> VirtualBusAdapter {
        let mut inner = self.lock();
        inner.ports.push(Port {
            open: false,
            filters: Vec::new(),
            inbox: BTreeMap::new(),
            notify: Arc::new(Notify::new()),
        });
        VirtualBusAdapter {
            bus: self.clone(),
            port: inner.ports.len() - 1,
        }
    }

    /// The bus bitrate.
    pub fn bitrate(&self) -> u32 {
        self.lock().bitrate
    }

    /// Reads or changes the vehicle state (speed, RPM, switches...).
    pub fn with_vehicle<T>(&self, f: impl FnOnce(&mut VehicleState) -> T) -> T {
        f(&mut self.lock().vehicle)
    }

    /// Reads or changes one ECU by name (e.g. to stage an odometer mismatch).
    pub fn with_ecu<T>(&self, name: &str, f: impl FnOnce(&mut EcuSim) -> T) -> Option<T> {
        let mut inner = self.lock();
        inner
            .nodes
            .iter_mut()
            .find(|n| n.ecu.name() == name)
            .map(|n| f(&mut n.ecu))
    }
}

/// One tool attached to a [`VirtualBus`].
pub struct VirtualBusAdapter {
    bus: VirtualBus,
    port: usize,
}

impl VirtualBusAdapter {
    /// The bus this adapter is attached to.
    pub fn bus(&self) -> &VirtualBus {
        &self.bus
    }
}

#[async_trait]
impl VehicleBusAdapter for VirtualBusAdapter {
    async fn open(&mut self, bitrate: u32) -> Result<()> {
        let mut inner = self.bus.lock();
        let matched = bitrate == inner.bitrate;
        let port = &mut inner.ports[self.port];
        port.open = matched;
        port.inbox.clear();
        if !matched {
            // A real controller at the wrong bitrate sees only error frames.
            tracing::debug!(bitrate, "virtual bus opened at the wrong bitrate");
            return Err(HalError::Protocol(format!(
                "bus error: no traffic at {bitrate} bit/s"
            )));
        }
        Ok(())
    }

    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()> {
        let mut inner = self.bus.lock();
        let port = &mut inner.ports[self.port];
        if !port.open {
            return Err(HalError::NotOpen);
        }
        port.filters = filters.to_vec();
        port.inbox.retain(|_, frame| passes(filters, frame));
        Ok(())
    }

    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
        let mut inner = self.bus.lock();
        if !inner.ports[self.port].open {
            return Err(HalError::NotOpen);
        }
        let now = inner.now_us();
        inner.pump(now);
        inner.deliver(now, frame, Some(self.port));
        inner.route_to_ecus(now, frame);
        Ok(())
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        let deadline = Instant::now() + timeout;
        loop {
            let (notify, wake_at) = {
                let mut inner = self.bus.lock();
                if !inner.ports[self.port].open {
                    return Err(HalError::NotOpen);
                }
                let now = inner.now_us();
                inner.pump(now);
                let start = inner.start;
                let next_periodic = inner.next_periodic_due();
                let port = &mut inner.ports[self.port];
                if let Some(entry) = port.inbox.first_entry() {
                    if entry.key().0 <= now {
                        return Ok(entry.remove());
                    }
                }
                let next_inbox = port.inbox.keys().next().map(|k| k.0);
                let next = [next_inbox, next_periodic].into_iter().flatten().min();
                let wake_at = next.map_or(deadline, |us| {
                    (start + Duration::from_micros(us)).min(deadline)
                });
                (Arc::clone(&port.notify), wake_at)
            };
            if Instant::now() >= deadline {
                return Err(HalError::Timeout(timeout));
            }
            tokio::select! {
                _ = tokio::time::sleep_until(wake_at) => {}
                _ = notify.notified() => {}
            }
        }
    }

    async fn close(&mut self) -> Result<()> {
        let mut inner = self.bus.lock();
        let port = &mut inner.ports[self.port];
        port.open = false;
        port.inbox.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::profiles::{falcon_ba, generic_uds};

    const T: Duration = Duration::from_millis(500);

    async fn open_generic() -> (VirtualBus, VirtualBusAdapter) {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut tester = bus.adapter();
        tester.open(500_000).await.unwrap();
        // Only diagnostic responses, not the periodic broadcast traffic.
        tester
            .set_filter(&[CanFilter::exact(generic_uds::ENGINE_RESP, false)])
            .await
            .unwrap();
        (bus, tester)
    }

    /// Task 1.1 gate: CAN frame round trip between two adapters on one bus.
    #[tokio::test(start_paused = true)]
    async fn can_round_trip_between_adapters() {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut a = bus.adapter();
        let mut b = bus.adapter();
        a.open(500_000).await.unwrap();
        b.open(500_000).await.unwrap();
        b.set_filter(&[
            CanFilter::exact(0x123, false),
            CanFilter::exact(0x18DA_F110, true),
        ])
        .await
        .unwrap();
        a.set_filter(&[CanFilter::exact(0x321, false)])
            .await
            .unwrap();

        let std = CanFrame::std(0x123, &[0xDE, 0xAD, 0xBE, 0xEF]);
        let ext = CanFrame::ext(0x18DA_F110, &[1, 2, 3, 4, 5, 6, 7, 8]);
        a.send_frame(&std).await.unwrap();
        a.send_frame(&ext).await.unwrap();
        assert_eq!(b.recv_frame(T).await.unwrap(), std);
        assert_eq!(b.recv_frame(T).await.unwrap(), ext);

        let reply = CanFrame::std(0x321, &[0x01]);
        b.send_frame(&reply).await.unwrap();
        assert_eq!(a.recv_frame(T).await.unwrap(), reply);
        // The sender does not hear itself.
        assert!(matches!(
            b.recv_frame(Duration::from_millis(50)).await,
            Err(HalError::Timeout(_))
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn receiver_sleeping_in_recv_is_woken_by_a_send() {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut a = bus.adapter();
        let mut b = bus.adapter();
        a.open(500_000).await.unwrap();
        b.open(500_000).await.unwrap();
        b.set_filter(&[CanFilter::exact(0x555, false)])
            .await
            .unwrap();
        let waiter = tokio::spawn(async move { b.recv_frame(Duration::from_secs(5)).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        a.send_frame(&CanFrame::std(0x555, &[7])).await.unwrap();
        assert_eq!(waiter.await.unwrap().unwrap().data(), &[7]);
    }

    #[tokio::test(start_paused = true)]
    async fn ecu_answers_single_frame_with_realistic_delay() {
        let (_bus, mut tester) = open_generic().await;
        let sent = Instant::now();
        tester
            .send_frame(&CanFrame::std(
                generic_uds::ENGINE_REQ,
                &[0x02, 0x10, 0x03, 0, 0, 0, 0, 0],
            ))
            .await
            .unwrap();
        let reply = tester.recv_frame(T).await.unwrap();
        assert_eq!(
            &reply.data()[..7],
            &[0x06, 0x50, 0x03, 0x00, 0x32, 0x01, 0xF4]
        );
        assert!(Instant::now() - sent >= Duration::from_millis(12));
    }

    #[tokio::test(start_paused = true)]
    async fn multi_frame_vin_honours_flow_control() {
        let (_bus, mut tester) = open_generic().await;
        tester
            .send_frame(&CanFrame::std(
                generic_uds::ENGINE_REQ,
                &[0x03, 0x22, 0xF1, 0x90, 0, 0, 0, 0],
            ))
            .await
            .unwrap();
        let ff = tester.recv_frame(T).await.unwrap();
        assert_eq!(&ff.data()[..2], &[0x10, 20]); // 62 F1 90 + 17-byte VIN
                                                  // Nothing more until the tester sends Flow Control.
        assert!(tester.recv_frame(Duration::from_millis(100)).await.is_err());
        tester
            .send_frame(&CanFrame::std(
                generic_uds::ENGINE_REQ,
                &[0x30, 0x00, 0x0A, 0, 0, 0, 0, 0],
            ))
            .await
            .unwrap();
        let cf1 = tester.recv_frame(T).await.unwrap();
        let t1 = Instant::now();
        let cf2 = tester.recv_frame(T).await.unwrap();
        assert!(
            Instant::now() - t1 >= Duration::from_millis(10),
            "STmin honoured"
        );
        assert_eq!((cf1.data()[0], cf2.data()[0]), (0x21, 0x22));
        let mut payload = ff.data()[2..].to_vec();
        payload.extend_from_slice(&cf1.data()[1..]);
        payload.extend_from_slice(&cf2.data()[1..]);
        payload.truncate(20);
        assert_eq!(&payload[3..], b"1HGCM82633A004352");
    }

    #[tokio::test(start_paused = true)]
    async fn functional_obd_request_reaches_only_obd_ecus() {
        let bus = VirtualBus::from_profile_id(falcon_ba::ID).unwrap();
        let mut tester = bus.adapter();
        tester.open(500_000).await.unwrap();
        tester
            .set_filter(&[CanFilter {
                id: 0x700,
                mask: 0x700,
                extended: false,
            }])
            .await
            .unwrap();
        bus.with_vehicle(|v| v.rpm = 750.0);
        tester
            .send_frame(&CanFrame::std(0x7DF, &[0x02, 0x01, 0x0C, 0, 0, 0, 0, 0]))
            .await
            .unwrap();
        let reply = tester.recv_frame(T).await.unwrap();
        assert_eq!(reply.id(), falcon_ba::PCM.1);
        assert_eq!(&reply.data()[..5], &[0x04, 0x41, 0x0C, 0x0B, 0xB8]);
        assert!(
            tester.recv_frame(Duration::from_millis(200)).await.is_err(),
            "IC and ABS stay silent"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bmw_extended_addressing_round_trip() {
        let bus = VirtualBus::from_profile_id(profiles::e90_dcan::ID).unwrap();
        let mut tester = bus.adapter();
        tester.open(500_000).await.unwrap();
        // KWP 0x1A 0x80 to the DME (0x12): tester 0x6F1, first byte = target.
        tester
            .send_frame(&CanFrame::std(
                0x6F1,
                &[0x12, 0x02, 0x1A, 0x80, 0xFF, 0xFF, 0xFF, 0xFF],
            ))
            .await
            .unwrap();
        let ff = tester.recv_frame(T).await.unwrap();
        assert_eq!(ff.id(), 0x612);
        assert_eq!(ff.data()[0], 0xF1, "reply addressed to the tester");
        assert_eq!(
            ff.data()[1] >> 4,
            0x1,
            "identification needs a multi-frame reply"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn wrong_bitrate_sees_nothing() {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut tester = bus.adapter();
        assert!(tester.open(250_000).await.is_err());
        assert!(matches!(
            tester
                .send_frame(&CanFrame::std(0x7E0, &[0x02, 0x3E, 0]))
                .await,
            Err(HalError::NotOpen)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn periodic_frames_stream_and_follow_vehicle_state() {
        let bus = VirtualBus::from_profile_id(generic_uds::ID).unwrap();
        let mut tester = bus.adapter();
        tester.open(500_000).await.unwrap();
        tester
            .set_filter(&[CanFilter::exact(0x0C9, false)])
            .await
            .unwrap();
        bus.with_vehicle(|v| v.rpm = 800.0);
        let start = Instant::now();
        let mut frames = Vec::new();
        while Instant::now() - start < Duration::from_secs(1) {
            frames.push(tester.recv_frame(T).await.unwrap());
        }
        assert!(
            frames.len() >= 99,
            "10 ms period gives ~100 frames/s, got {}",
            frames.len()
        );
        assert_eq!(&frames[0].data()[..2], &(3200u16).to_be_bytes());
    }

    #[tokio::test(start_paused = true)]
    async fn session_times_out_without_tester_present() {
        let (bus, mut tester) = open_generic().await;
        tester
            .send_frame(&CanFrame::std(
                generic_uds::ENGINE_REQ,
                &[0x02, 0x10, 0x03, 0, 0, 0, 0, 0],
            ))
            .await
            .unwrap();
        tester.recv_frame(T).await.unwrap();
        tokio::time::sleep(Duration::from_secs(6)).await;
        // Any request after S3 finds the ECU back in the default session.
        tester
            .send_frame(&CanFrame::std(
                generic_uds::ENGINE_REQ,
                &[0x02, 0x3E, 0x00, 0, 0, 0, 0, 0],
            ))
            .await
            .unwrap();
        tester.recv_frame(T).await.unwrap();
        let session = bus.with_ecu("ENGINE", |ecu| ecu.session()).unwrap();
        assert_eq!(session, crate::sim::ecu::Session::Default);
    }
}
