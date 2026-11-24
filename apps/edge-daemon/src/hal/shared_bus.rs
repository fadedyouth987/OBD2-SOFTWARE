//! Thread-safe shared CAN bus multiplexer (unblocks physical adapters in ws.rs).
//!
//! An actor owns the physical [`VehicleBusAdapter`] so port handles never hold
//! the adapter mutex across `recv_frame`. Pending sends are drained before each
//! short recv slice. Every port has its own mpsc queue (512 frames); overflow
//! is reported as [`HalError::Protocol`] rather than silently dropping frames.

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use crate::hal::{passes, CanFilter, CanFrame, HalError, Result, VehicleBusAdapter};

const PORT_QUEUE: usize = 512;
const RECV_SLICE: Duration = Duration::from_millis(20);
const CMD_QUEUE: usize = 64;

enum Command {
    Send {
        frame: CanFrame,
        reply: oneshot::Sender<Result<()>>,
    },
}

struct Sub {
    tx: mpsc::Sender<CanFrame>,
    lagged: Arc<AtomicBool>,
}

/// Shares one physical `VehicleBusAdapter` across 20 Hz streaming and ISO-TP channels.
#[derive(Clone)]
pub struct SharedBus {
    cmd: mpsc::Sender<Command>,
    subs: Arc<Mutex<Vec<Sub>>>,
    actor: Arc<Mutex<Option<JoinHandle<()>>>>,
    bitrate: u32,
}

impl SharedBus {
    pub async fn open(mut adapter: Box<dyn VehicleBusAdapter>, bitrate: u32) -> Result<Self> {
        adapter.open(bitrate).await?;
        let (cmd, cmd_rx) = mpsc::channel(CMD_QUEUE);
        let subs = Arc::new(Mutex::new(Vec::new()));
        let actor = tokio::spawn(run_actor(adapter, cmd_rx, Arc::clone(&subs)));
        Ok(Self {
            cmd,
            subs,
            actor: Arc::new(Mutex::new(Some(actor))),
            bitrate,
        })
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn port(&self) -> SharedBusPort {
        let (tx, rx) = mpsc::channel(PORT_QUEUE);
        let lagged = Arc::new(AtomicBool::new(false));
        self.subs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Sub {
                tx,
                lagged: Arc::clone(&lagged),
            });
        SharedBusPort {
            cmd: self.cmd.clone(),
            rx,
            lagged,
            filters: Vec::new(),
        }
    }
}

impl Drop for SharedBus {
    fn drop(&mut self) {
        if Arc::strong_count(&self.actor) == 1 {
            if let Ok(mut guard) = self.actor.lock() {
                if let Some(h) = guard.take() {
                    h.abort();
                }
            }
        }
    }
}

async fn run_actor(
    mut adapter: Box<dyn VehicleBusAdapter>,
    mut cmd_rx: mpsc::Receiver<Command>,
    subs: Arc<Mutex<Vec<Sub>>>,
) {
    loop {
        // Drain pending sends before starting a recv so a 20 ms slice cannot
        // starve outbound frames.
        while let Ok(cmd) = cmd_rx.try_recv() {
            handle(&mut adapter, cmd).await;
        }
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(cmd) => handle(&mut adapter, cmd).await,
                    None => return,
                }
            }
            frame = adapter.recv_frame(RECV_SLICE) => {
                match frame {
                    Ok(frame) => fanout(&subs, frame),
                    Err(HalError::Timeout(_)) => {}
                    Err(_) => return,
                }
            }
        }
    }
}

async fn handle(adapter: &mut Box<dyn VehicleBusAdapter>, cmd: Command) {
    match cmd {
        Command::Send { frame, reply } => {
            let _ = reply.send(adapter.send_frame(&frame).await);
        }
    }
}

fn fanout(subs: &Arc<Mutex<Vec<Sub>>>, frame: CanFrame) {
    let mut guard = subs.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|s| !s.tx.is_closed());
    for s in guard.iter() {
        match s.tx.try_send(frame.clone()) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                s.lagged.store(true, Ordering::SeqCst);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {}
        }
    }
}

/// Independent port handle on a [`SharedBus`].
pub struct SharedBusPort {
    cmd: mpsc::Sender<Command>,
    rx: mpsc::Receiver<CanFrame>,
    lagged: Arc<AtomicBool>,
    filters: Vec<CanFilter>,
}

#[async_trait]
impl VehicleBusAdapter for SharedBusPort {
    async fn open(&mut self, _bitrate: u32) -> Result<()> {
        Ok(())
    }

    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()> {
        self.filters = filters.to_vec();
        Ok(())
    }

    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.cmd
            .send(Command::Send {
                frame: frame.clone(),
                reply,
            })
            .await
            .map_err(|_| HalError::NotOpen)?;
        rx.await.map_err(|_| HalError::NotOpen)?
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.lagged.swap(false, Ordering::SeqCst) {
                return Err(HalError::Protocol(
                    "shared bus port lagged; frames dropped".into(),
                ));
            }
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(timeout));
            }
            match tokio::time::timeout(left, self.rx.recv()).await {
                Ok(Some(frame)) => {
                    if passes(&self.filters, &frame) {
                        return Ok(frame);
                    }
                }
                Ok(None) => return Err(HalError::NotOpen),
                Err(_) => return Err(HalError::Timeout(timeout)),
            }
        }
    }

    async fn close(&mut self) -> Result<()> {
        Ok(())
    }
}

/// Simple mutex-guarded adapter wrapper for single-consumer use.
#[derive(Clone)]
pub struct SharedBusAdapter<A> {
    inner: Arc<tokio::sync::Mutex<A>>,
}

impl<A> SharedBusAdapter<A> {
    pub fn new(adapter: A) -> Self {
        Self {
            inner: Arc::new(tokio::sync::Mutex::new(adapter)),
        }
    }
}

#[async_trait]
impl<A: VehicleBusAdapter> VehicleBusAdapter for SharedBusAdapter<A> {
    async fn open(&mut self, bitrate: u32) -> Result<()> {
        self.inner.lock().await.open(bitrate).await
    }

    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()> {
        self.inner.lock().await.set_filter(filters).await
    }

    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
        self.inner.lock().await.send_frame(frame).await
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        self.inner.lock().await.recv_frame(timeout).await
    }

    async fn close(&mut self) -> Result<()> {
        self.inner.lock().await.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use tokio::sync::Mutex as AsyncMutex;

    // Shared handle so tests can inject frames after the adapter is moved into SharedBus.
    struct PumpHandle {
        incoming: Arc<AsyncMutex<VecDeque<CanFrame>>>,
        sent: Arc<AsyncMutex<Vec<CanFrame>>>,
        notify: Arc<tokio::sync::Notify>,
    }

    struct PumpAdapterArc {
        incoming: Arc<AsyncMutex<VecDeque<CanFrame>>>,
        sent: Arc<AsyncMutex<Vec<CanFrame>>>,
        notify: Arc<tokio::sync::Notify>,
    }

    fn pump() -> (PumpAdapterArc, PumpHandle) {
        let incoming = Arc::new(AsyncMutex::new(VecDeque::new()));
        let sent = Arc::new(AsyncMutex::new(Vec::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        (
            PumpAdapterArc {
                incoming: Arc::clone(&incoming),
                sent: Arc::clone(&sent),
                notify: Arc::clone(&notify),
            },
            PumpHandle {
                incoming,
                sent,
                notify,
            },
        )
    }

    #[async_trait]
    impl VehicleBusAdapter for PumpAdapterArc {
        async fn open(&mut self, _bitrate: u32) -> Result<()> {
            Ok(())
        }

        async fn set_filter(&mut self, _filters: &[CanFilter]) -> Result<()> {
            Ok(())
        }

        async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
            self.sent.lock().await.push(frame.clone());
            Ok(())
        }

        async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                if let Some(frame) = self.incoming.lock().await.pop_front() {
                    return Ok(frame);
                }
                let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                if left.is_zero() {
                    return Err(HalError::Timeout(timeout));
                }
                match tokio::time::timeout(left, self.notify.notified()).await {
                    Ok(()) => continue,
                    Err(_) => return Err(HalError::Timeout(timeout)),
                }
            }
        }

        async fn close(&mut self) -> Result<()> {
            Ok(())
        }
    }

    impl PumpHandle {
        async fn push(&self, frame: CanFrame) {
            self.incoming.lock().await.push_back(frame);
            self.notify.notify_waiters();
        }
    }

    #[tokio::test]
    async fn port_receives_injected_frames_and_sends() {
        let (adapter, handle) = pump();
        let bus = SharedBus::open(Box::new(adapter), 500_000).await.unwrap();
        let mut port = bus.port();
        let frame = CanFrame::std(0x7DF, &[0x02, 0x01, 0x0D]);
        handle.push(frame.clone()).await;
        let got = port
            .recv_frame(Duration::from_millis(200))
            .await
            .expect("frame");
        assert_eq!(got, frame);

        let out = CanFrame::std(0x7E0, &[0x02, 0x01, 0x0C]);
        port.send_frame(&out).await.unwrap();
        // Actor may need a slice to drain the send if it is mid-recv.
        let start = tokio::time::Instant::now();
        loop {
            if handle.sent.lock().await.last() == Some(&out) {
                break;
            }
            if start.elapsed() > Duration::from_millis(200) {
                panic!("send was not delivered to the physical adapter");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    #[tokio::test]
    async fn lagged_port_returns_protocol_error() {
        let (adapter, handle) = pump();
        let bus = SharedBus::open(Box::new(adapter), 500_000).await.unwrap();
        let mut port = bus.port();

        for i in 0..(PORT_QUEUE as u32 + 8) {
            handle.push(CanFrame::std(0x100, &[(i % 256) as u8])).await;
        }
        // Give the actor time to fan out more than PORT_QUEUE frames.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let err = port
            .recv_frame(Duration::from_millis(50))
            .await
            .expect_err("lag must be reported");
        assert!(
            matches!(err, HalError::Protocol(ref m) if m.contains("lagged")),
            "unexpected error: {err:?}"
        );
    }

    #[tokio::test]
    async fn send_is_not_blocked_for_a_full_recv_timeout() {
        let (adapter, handle) = pump();
        let bus = SharedBus::open(Box::new(adapter), 500_000).await.unwrap();
        let mut port = bus.port();

        // Actor is parked in recv_frame (no inbound frames). A send must still
        // complete on the next command poll, not after a long outstanding recv
        // that held a shared mutex.
        let out = CanFrame::std(0x200, &[0x01]);
        let start = tokio::time::Instant::now();
        port.send_frame(&out).await.unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(100),
            "send waited {elapsed:?}, actor should drain commands around a 20 ms recv slice"
        );
        let start = tokio::time::Instant::now();
        loop {
            if handle.sent.lock().await.last() == Some(&out) {
                break;
            }
            if start.elapsed() > Duration::from_millis(200) {
                panic!("send did not reach the adapter");
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
}
