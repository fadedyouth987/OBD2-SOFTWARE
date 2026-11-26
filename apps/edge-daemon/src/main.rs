//! edge-daemon: the local service between the vehicle and the web app.
//!
//! ```text
//! edge-daemon            serve on 127.0.0.1:8765 and [::1]:8765
//! edge-daemon pair       print a 6-digit pairing code (single use, 2 minutes)
//! edge-daemon version    print daemon, protocol and safety-policy versions
//! edge-daemon diagnostics [file]   write a redacted support bundle (Task 5.2)
//! ```
//!
//! Environment: `EDGE_PORT` (default 8765), `EDGE_ALLOWED_ORIGINS` (comma
//! separated, default `http://localhost:3000` for development),
//! `EDGE_DATA_DIR` (pairing codes, audit log, lease; default per user),
//! `EDGE_DEVICE_ID` (must match the lease `rcid` claim when set),
//! `EDGE_LEASE_MIN_VERSION` (leases with a lower `lease_ver` are revoked),
//! `RUST_LOG` (default `info`). Logs also go to `<data dir>/logs/edge-daemon.log`,
//! rotated at 10 MB with five old files kept (`EDGE_LOG_FILE=off` to disable). An offline lease is read from
//! `<data dir>/lease.jwt` when present, and an immobilizer lease from
//! `<data dir>/immo_lease.jwt` when present; those machine leases serve
//! code-paired native clients (and browser users only when issued to them).
//! Leases installed from the web app are per technician, under
//! `<data dir>/leases/<user>.jwt` and `<data dir>/immo_leases/<user>.jwt`.
//! Replacing `lease.jwt` or
//! `<data dir>/lease.min_ver` bumps the lease epoch and closes open sockets.

use std::{
    path::PathBuf,
    process::ExitCode,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};

use edge_daemon::{
    auth::unix_now,
    hal::discovery,
    protocol,
    safety::audit::JsonlAudit,
    server::{
        pairing::PairingStore,
        ws::{Server, ServerConfig, DEFAULT_PORT},
    },
    telemetry::{logfile, support_bundle},
};
use tracing_subscriber::fmt::writer::MakeWriterExt;

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
        edge_daemon::auth::dev_keys::keyring(),
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
    cfg.data_dir = Some(dir.clone());
    // Leases browser users installed for themselves (leases/<user>.jwt).
    cfg.load_user_leases();
    if let Ok(mut immo) = cfg.live_immo_lease.lock() {
        immo.clone_from(&cfg.immo_lease_token);
    }
    if let Ok(id) = std::env::var("EDGE_DEVICE_ID") {
        let id = id.trim();
        if !id.is_empty() {
            cfg.device_id = Some(id.to_owned());
        }
    }
    if let Ok(v) = std::env::var("EDGE_LEASE_MIN_VERSION") {
        if let Ok(n) = v.trim().parse::<i64>() {
            cfg.lease_min_version.store(n, Ordering::SeqCst);
        }
    }
    if let Ok(s) = std::fs::read_to_string(dir.join("lease.min_ver")) {
        if let Ok(n) = s.trim().parse::<i64>() {
            cfg.lease_min_version.store(n, Ordering::SeqCst);
        }
    }
    {
        let mut live = cfg.live_lease.lock().expect("live lease lock");
        *live = cfg.lease_token.clone();
    }
    if cfg.keys.is_empty() {
        tracing::info!("no cloud keys pinned yet: COMMUNITY tier, local pairing codes only");
    }
    let live = Arc::clone(&cfg.live_lease);
    let epoch = Arc::clone(&cfg.lease_epoch);
    let min_ver = Arc::clone(&cfg.lease_min_version);
    let lease_path = dir.join("lease.jwt");
    let min_path = dir.join("lease.min_ver");
    let mut last_min = min_ver.load(Ordering::SeqCst);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            // Compared with the live lease under its lock: a LeaseInstallRequest
            // writes the file and the live value together, so it is not seen as a change.
            if let Ok(mut guard) = live.lock() {
                let new_lease = std::fs::read_to_string(&lease_path).ok();
                if new_lease != *guard {
                    *guard = new_lease;
                    epoch.fetch_add(1, Ordering::SeqCst);
                    tracing::info!("lease.jwt changed; open sessions will be asked to reconnect");
                }
            }
            if let Ok(s) = std::fs::read_to_string(&min_path) {
                if let Ok(n) = s.trim().parse::<i64>() {
                    if n != last_min {
                        last_min = n;
                        min_ver.store(n, Ordering::SeqCst);
                        epoch.fetch_add(1, Ordering::SeqCst);
                        tracing::info!(
                            min_version = n,
                            "lease.min_ver changed; open sessions will reconnect"
                        );
                    }
                }
            }
        }
    });
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
    let dir = data_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("cannot create data directory {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
    };
    let file_logging = std::env::var("EDGE_LOG_FILE").map_or(true, |v| v != "off");
    let log_file = if file_logging {
        logfile::RotatingFile::open(
            &logfile::log_dir(&dir),
            logfile::DEFAULT_MAX_BYTES,
            logfile::DEFAULT_KEEP,
        )
        .map_err(|e| eprintln!("file logging off: {e}"))
        .ok()
    } else {
        None
    };
    match log_file {
        Some(file) => tracing_subscriber::fmt()
            .with_env_filter(filter())
            .with_ansi(false)
            .with_writer(std::io::stderr.and(Mutex::new(file)))
            .init(),
        None => tracing_subscriber::fmt().with_env_filter(filter()).init(),
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
        Some("diagnostics") => {
            let out = std::env::args().nth(2).map(PathBuf::from);
            match support_bundle::write(&dir, out, &discovery::discover(), unix_now()) {
                Ok(path) => {
                    println!("Support bundle written to {}", path.display());
                    println!("VIN serials, tokens and keys are removed. Check it before sending.");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("could not write the support bundle: {e}");
                    ExitCode::FAILURE
                }
            }
        }
        Some(other) => {
            eprintln!(
                "unknown command {other:?}; use: edge-daemon [serve|pair|version|diagnostics]"
            );
            ExitCode::FAILURE
        }
    }
}
