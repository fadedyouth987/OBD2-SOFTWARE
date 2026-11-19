//! edge-daemon entry point.
//!
//! Hardware adapters, protocols, the safety interlock and the WebSocket server
//! arrive in Phase 1 (Tasks 1.1–1.4).

use edge_daemon::protocol;

fn main() {
    println!(
        "edge-daemon {} (protocol {}, safety policy {})",
        env!("CARGO_PKG_VERSION"),
        protocol::PROTOCOL_VERSION,
        protocol::policy_version(),
    );
}
