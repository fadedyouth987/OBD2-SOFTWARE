//! Thread-safe shared CAN bus multiplexer (unblocks physical adapters in ws.rs).
//!
//! Allows the 20 Hz PID/frame streaming loop and on-demand `DiagChannel` requests
//! to share one physical `VehicleBusAdapter` (STN, SLCAN, SocketCAN, J2534) safely
//! via a background reader that broadcasts every received frame to all ports.

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::{
    sync::{broadcast, Mutex},
    task::JoinHandle,
};

use crate::hal::{passes, CanFilter, CanFrame, HalError, Result, VehicleBusAdapter};

/// Shares one physical `VehicleBusAdapter` across 20 Hz streaming and ISO-TP channels.
#[derive(Clone)]
pub struct SharedBus {
    inner: Arc<Mutex<Box<dyn VehicleBusAdapter>>>,
    tx: broadcast::Sender<CanFrame>,
    bitrate: u32,
    reader: Arc<JoinHandle<()>>,
}

impl SharedBus {
    pub async fn open(mut adapter: Box<dyn VehicleBusAdapter>, bitrate: u32) -> Result<Self> {
        adapter.open(bitrate).await?;
        let inner = Arc::new(Mutex::new(adapter));
        let (tx, _) = broadcast::channel(512);

        let rx_inner = Arc::clone(&inner);
        let rx_tx = tx.clone();
        let reader = tokio::spawn(async move {
            loop {
                let res = {
                    let mut guard = rx_inner.lock().await;
                    guard.recv_frame(Duration::from_millis(20)).await
                };
                match res {
                    Ok(frame) => {
                        let _ = rx_tx.send(frame);
                    }
                    Err(HalError::Timeout(_)) => tokio::task::yield_now().await,
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            inner,
            tx,
            bitrate,
            reader: Arc::new(reader),
        })
    }

    pub fn bitrate(&self) -> u32 {
        self.bitrate
    }

    pub fn port(&self) -> SharedBusPort {
        SharedBusPort {
            inner: Arc::clone(&self.inner),
            rx: self.tx.subscribe(),
            filters: Vec::new(),
        }
    }
}

impl Drop for SharedBus {
    fn drop(&mut self) {
        if Arc::strong_count(&self.reader) == 1 {
            self.reader.abort();
        }
    }
}

/// Independent port handle on a [`SharedBus`].
pub struct SharedBusPort {
    inner: Arc<Mutex<Box<dyn VehicleBusAdapter>>>,
    rx: broadcast::Receiver<CanFrame>,
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
        self.inner.lock().await.send_frame(frame).await
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return Err(HalError::Timeout(timeout));
            }
            match tokio::time::timeout(left, self.rx.recv()).await {
                Ok(Ok(frame)) => {
                    if passes(&self.filters, &frame) {
                        return Ok(frame);
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(broadcast::error::RecvError::Closed)) => return Err(HalError::NotOpen),
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
    inner: Arc<Mutex<A>>,
}

impl<A> SharedBusAdapter<A> {
    pub fn new(adapter: A) -> Self {
        Self {
            inner: Arc::new(Mutex::new(adapter)),
        }
    }
}

#[async_trait]
impl<A: VehicleBusAdapter + Send> VehicleBusAdapter for SharedBusAdapter<A> {
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
