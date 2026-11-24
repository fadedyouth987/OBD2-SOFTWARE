//! edge-daemon: the local service between the vehicle and the web app.
//!
//! ```text
//! edge-daemon            serve on 127.0.0.1:8765 and [::1]:8765
//! edge-daemon pair       print a 6-digit pairing code (single use, 2 minutes)
//! edge-daemon version    print daemon, protocol and safety-policy versions
//! ```
//!
//! Environment: `EDGE_PORT` (default 8765), `EDGE_ALLOWED_ORIGINS` (comma
//! separated, default `http://localhost:3000` for development),
//! `EDGE_DATA_DIR` (pairing codes, audit log, lease; default per user),
//! `RUST_LOG` (default `info`). An offline lease is read from
//! `<data dir>/lease.jwt` when present, and an immobilizer lease from
//! `<data dir>/immo_lease.jwt` when present.

use std::{path::PathBuf, process::ExitCode, sync::Arc};

use edge_daemon::{
    auth::{cloud_keys::KeyRing, unix_now},
    protocol,
    safety::audit::JsonlAudit,
    server::{
        pairing::PairingStore,
        ws::{Server, ServerConfig, DEFAULT_PORT},
    },
};

fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("EDGE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("obd2-edge");
        }
    }
    std::env::var_os("HOME").map_or_else(
        || PathBuf::from("."),
        |h| PathBuf::from(h).join(".local/share/obd2-edge"),
    )
}

fn pair(dir: &std::path::Path) -> ExitCode {
    match PairingStore::at(dir.join("pairing.json")).issue(unix_now()) {
        Ok(code) => {
            println!("Pairing code: {code}");
            println!("Enter it in the app within 2 minutes. It works once.");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!(
                "could not write the pairing code under {}: {e}",
                dir.display()
            );
            ExitCode::FAILURE
        }
    }
}

async fn serve(dir: PathBuf) -> ExitCode {
    let mut cfg = ServerConfig::new(
        KeyRing::production(),
        Arc::new(PairingStore::at(dir.join("pairing.json"))),
        Arc::new(JsonlAudit::new(dir.join("audit.jsonl"))),
    );
    cfg.port = std::env::var("EDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    if let Ok(origins) = std::env::var("EDGE_ALLOWED_ORIGINS") {
        cfg.allowed_origins = origins
            .split(',')
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .map(String::from)
            .collect();
    }
    cfg.lease_token = std::fs::read_to_string(dir.join("lease.jwt")).ok();
    cfg.immo_lease_token = std::fs::read_to_string(dir.join("immo_lease.jwt")).ok();
    if cfg.keys.is_empty() {
        tracing::info!("no cloud keys pinned yet: COMMUNITY tier, local pairing codes only");
    }
    let origins = cfg.allowed_origins.join(", ");
    let server = match Server::bind(cfg).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("cannot listen on the edge port: {e}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(port = server.port(), %origins, data = %dir.display(), "edge-daemon listening on loopback");
    tokio::select! {
        () = server.run() => {}
        _ = tokio::signal::ctrl_c() => tracing::info!("shutting down"),
    }
    ExitCode::SUCCESS
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let dir = data_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("cannot create data directory {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    match std::env::args().nth(1).as_deref() {
        None | Some("serve") => serve(dir).await,
        Some("pair") => pair(&dir),
        Some("version" | "--version") => {
            println!(
                "edge-daemon {} (protocol {}, safety policy {})",
                env!("CARGO_PKG_VERSION"),
                protocol::PROTOCOL_VERSION,
                protocol::policy_version()
            );
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("unknown command {other:?}; use: edge-daemon [serve|pair|version]");
            ExitCode::FAILURE
        }
    }
}
