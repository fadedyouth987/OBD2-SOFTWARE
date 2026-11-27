//! edge-daemon: the local service between the vehicle and the web app.
//!
//! ```text
//! edge-daemon            serve on 127.0.0.1:8765 and [::1]:8765
//! edge-daemon pair       print a 6-digit pairing code (single use, 2 minutes)
//! edge-daemon version    print daemon, protocol and safety-policy versions
//! edge-daemon diagnostics [file]   write a redacted support bundle (Task 5.2)
//! edge-daemon service    run under the Windows service manager (the MSI installs it)
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
        pairing::{pairing_path, PairingStore},
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

/// The installed service's data folder (Linux package, Windows MSI), when present.
fn installed_data_dir() -> Option<PathBuf> {
    let dir = if cfg!(windows) {
        PathBuf::from(std::env::var_os("PROGRAMDATA")?).join("RootCauseOBD")
    } else {
        PathBuf::from("/var/lib/obd2-edge")
    };
    // The folder itself, not pairing/: a user outside the technicians group
    // can't look inside, and should get "ask to be added", not a private code.
    dir.is_dir().then_some(dir)
}

/// Where `edge-daemon pair` writes: `EDGE_DATA_DIR` when set, else the installed
/// service's folder, else the per-user one. A shell that missed the installer's
/// profile or system variable (sudo, ssh, an old terminal) still pairs with the
/// running service instead of printing a code nobody reads.
fn pair_dir() -> PathBuf {
    if std::env::var_os("EDGE_DATA_DIR").is_some() {
        return data_dir();
    }
    installed_data_dir().unwrap_or_else(data_dir)
}

fn pair(dir: &std::path::Path) -> ExitCode {
    let path = pairing_path(dir);
    match PairingStore::at(&path).issue(unix_now()) {
        Ok(code) => {
            println!("Pairing code: {code}");
            println!("Enter it in the app within 2 minutes. It works once.");
            println!("(saved for the daemon using {})", dir.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!(
                "could not write the pairing code to {}: {e}",
                path.display()
            );
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                eprintln!(
                    "On an installed daemon, ask an administrator to add you to the technicians group \
                     (Linux: obd2-edge; Windows: \"RootCause Technicians\"), then sign in again."
                );
            }
            ExitCode::FAILURE
        }
    }
}

/// Origins a release daemon trusts when `EDGE_ALLOWED_ORIGINS` is unset: the
/// production web app only, so a lost setting never falls back to a dev origin.
const PRODUCTION_ORIGIN: &str = "https://app.rootcauseobd.com.au";

/// `lease.min_ver` only ever goes up: a lower value (an old file, a tampered
/// one) would bring revoked leases back.
fn raise_min_version(current: i64, file: i64) -> Option<i64> {
    (file > current).then_some(file)
}

/// Runs the daemon until `stop` resolves. `listening` is called once the port
/// is bound (the Windows service reports Running only then).
async fn serve(
    dir: PathBuf,
    stop: impl std::future::Future<Output = ()>,
    listening: impl FnOnce(),
) -> ExitCode {
    let mut cfg = ServerConfig::new(
        edge_daemon::auth::dev_keys::keyring(),
        Arc::new(PairingStore::at(pairing_path(&dir))),
        Arc::new(JsonlAudit::new(dir.join("audit.jsonl"))),
    );
    cfg.port = std::env::var("EDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);
    if !cfg!(debug_assertions) {
        cfg.allowed_origins = vec![PRODUCTION_ORIGIN.to_owned()];
    }
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
                    if n < last_min {
                        tracing::warn!(
                            file = n,
                            current = last_min,
                            "lease.min_ver went down; ignored (it can only be raised)"
                        );
                    }
                    if let Some(n) = raise_min_version(last_min, n) {
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
            // Logged, not just printed: a service has no console to print to.
            tracing::error!("cannot listen on the edge port: {e}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!(port = server.port(), %origins, data = %dir.display(), "edge-daemon listening on loopback");
    if origins.contains("localhost") && !cfg!(debug_assertions) {
        tracing::warn!("a release daemon is trusting a localhost origin ({origins})");
    }
    listening();
    tokio::select! {
        () = server.run() => {
            tracing::error!("the WebSocket server stopped unexpectedly");
            ExitCode::FAILURE
        }
        () = stop => {
            tracing::info!("shutting down");
            ExitCode::SUCCESS
        }
    }
}

/// Ctrl-C in a console, or SIGTERM from systemd (`systemctl stop`/restart).
async fn console_stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
}

fn main() -> ExitCode {
    let command = std::env::args().nth(1);
    let dir = if command.as_deref() == Some("pair") {
        pair_dir()
    } else {
        data_dir()
    };
    // Only the long-running daemon writes the log file; `edge-daemon pair`, run
    // by a technician in a shared install, must not touch the service's logs.
    let serving = matches!(command.as_deref(), None | Some("serve" | "service"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("cannot create data directory {}: {e}", dir.display());
        return ExitCode::FAILURE;
    }
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"))
    };
    let file_logging = serving && std::env::var("EDGE_LOG_FILE").map_or(true, |v| v != "off");
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
    match command.as_deref() {
        None | Some("serve") => runtime().block_on(serve(dir, console_stop(), || {})),
        Some("service") => service::run(),
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
                "unknown command {other:?}; use: edge-daemon [serve|pair|version|diagnostics|service]"
            );
            ExitCode::FAILURE
        }
    }
}

/// `edge-daemon service`: the Windows service manager starts the daemon this
/// way (the MSI installs it as `RootCauseEdgeDaemon`). It reports StartPending
/// until the port is bound, then Running; Stop and system shutdown end `serve`
/// the same way Ctrl-C does in a console. A failure exit makes the service
/// manager run the MSI's recovery actions (restart).
#[cfg(windows)]
mod service {
    use std::{ffi::OsString, process::ExitCode, sync::Mutex, time::Duration};

    use windows_service::{
        define_windows_service,
        service::{
            ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
            ServiceType,
        },
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
    };

    /// Must match `ServiceInstall/@Name` in packaging/windows/edge-daemon.wxs.
    pub const NAME: &str = "RootCauseEdgeDaemon";

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() -> ExitCode {
        match service_dispatcher::start(NAME, ffi_service_main) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!(
                    "edge-daemon service must be started by the Windows service manager: {e}"
                );
                ExitCode::FAILURE
            }
        }
    }

    fn status(state: ServiceState, exit: u32) -> ServiceStatus {
        ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running {
                ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
            } else {
                ServiceControlAccept::empty()
            },
            exit_code: ServiceExitCode::Win32(exit),
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        }
    }

    fn service_main(_args: Vec<OsString>) {
        if let Err(e) = run_service() {
            tracing::error!("Windows service failed: {e}");
        }
    }

    fn run_service() -> windows_service::Result<()> {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = Mutex::new(Some(tx));
        let handle = service_control_handler::register(NAME, move |control| match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(());
                }
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })?;
        handle.set_service_status(status(ServiceState::StartPending, 0))?;
        let code = super::runtime().block_on(super::serve(
            super::data_dir(),
            async {
                let _ = rx.await;
            },
            || {
                if let Err(e) = handle.set_service_status(status(ServiceState::Running, 0)) {
                    tracing::error!("could not report Running to the service manager: {e}");
                }
            },
        ));
        // ERROR_SERVICE_SPECIFIC_ERROR-style failure: the recovery actions restart it.
        let exit = if code == ExitCode::SUCCESS { 0 } else { 1 };
        handle.set_service_status(status(ServiceState::Stopped, exit))?;
        Ok(())
    }
}

#[cfg(not(windows))]
mod service {
    use std::process::ExitCode;

    pub fn run() -> ExitCode {
        eprintln!(
            "`edge-daemon service` is for the Windows service manager; run `edge-daemon` here"
        );
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::raise_min_version;

    #[test]
    fn lease_min_version_only_goes_up() {
        assert_eq!(raise_min_version(3, 4), Some(4));
        assert_eq!(raise_min_version(3, 3), None);
        assert_eq!(
            raise_min_version(3, 1),
            None,
            "a lower value never un-revokes leases"
        );
    }
}
