//! Edge daemon observability & Prometheus metrics (Task 5.2, A-CEO-5).

pub mod logfile;
pub mod support_bundle;

use std::sync::atomic::{AtomicU64, Ordering};

/// Lightweight lock-free counters exposed by the edge daemon.
#[derive(Debug, Default)]
pub struct EdgeMetrics {
    pub ws_connections_total: AtomicU64,
    pub can_frames_rx_total: AtomicU64,
    pub pid_samples_total: AtomicU64,
    pub gated_allowed_total: AtomicU64,
    pub gated_refused_total: AtomicU64,
    pub ring_buffer_bytes: AtomicU64,
}

impl EdgeMetrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn inc_ws(&self) {
        self.ws_connections_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_can_frames(&self, count: u64) {
        self.can_frames_rx_total.fetch_add(count, Ordering::Relaxed);
    }

    pub fn inc_gated(&self, allowed: bool) {
        if allowed {
            self.gated_allowed_total.fetch_add(1, Ordering::Relaxed);
        } else {
            self.gated_refused_total.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn set_ring_buffer_bytes(&self, bytes: u64) {
        self.ring_buffer_bytes.store(bytes, Ordering::Relaxed);
    }

    /// Renders metrics in Prometheus text exposition format (0.0.4).
    pub fn render_prometheus(&self) -> String {
        format!(
            concat!(
                "# TYPE obd2_edge_ws_connections_total counter\n",
                "obd2_edge_ws_connections_total {}\n",
                "# TYPE obd2_edge_can_frames_rx_total counter\n",
                "obd2_edge_can_frames_rx_total {}\n",
                "# TYPE obd2_edge_pid_samples_total counter\n",
                "obd2_edge_pid_samples_total {}\n",
                "# TYPE obd2_edge_gated_allowed_total counter\n",
                "obd2_edge_gated_allowed_total {}\n",
                "# TYPE obd2_edge_gated_refused_total counter\n",
                "obd2_edge_gated_refused_total {}\n",
                "# TYPE obd2_edge_ring_buffer_bytes gauge\n",
                "obd2_edge_ring_buffer_bytes {}\n"
            ),
            self.ws_connections_total.load(Ordering::Relaxed),
            self.can_frames_rx_total.load(Ordering::Relaxed),
            self.pid_samples_total.load(Ordering::Relaxed),
            self.gated_allowed_total.load(Ordering::Relaxed),
            self.gated_refused_total.load(Ordering::Relaxed),
            self.ring_buffer_bytes.load(Ordering::Relaxed),
        )
    }
}
