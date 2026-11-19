//! J2534 PassThru adapter (Task 1.1, A-ENG-1).
//!
//! The daemon never loads a vendor DLL itself. It starts `j2534-bridge` (a
//! 32-bit process, shipped next to the daemon), which loads the DLL and talks
//! line-delimited JSON over stdin/stdout. A crashing DLL kills only the bridge;
//! this adapter reports it as an `ADAPTER_ERROR`-style failure.
//!
//! J2534 itself is Windows-only, but this client is portable so its bridge
//! round trip is tested everywhere against the bridge's `--loopback` mode.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use async_trait::async_trait;
use j2534_bridge::proto::{self, DeviceInfo, Filter, Request, Response, BRIDGE_PROTOCOL};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use super::{CanFilter, CanFrame, HalError, Result, VehicleBusAdapter};

/// How long the bridge may take to load a DLL and open the device.
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const CALL_TIMEOUT: Duration = Duration::from_secs(2);

/// The bridge executable shipped next to the daemon.
pub fn default_bridge_path() -> PathBuf {
    let name = if cfg!(windows) {
        "j2534-bridge.exe"
    } else {
        "j2534-bridge"
    };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(name)))
        .unwrap_or_else(|| PathBuf::from(name))
}

struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

/// A J2534 device reached through the bridge process.
pub struct J2534Adapter {
    bridge: PathBuf,
    args: Vec<String>,
    dll: String,
    proc: Option<Bridge>,
}

impl J2534Adapter {
    /// `dll` is the FunctionLibrary path from the PassThruSupport.04.04 registry entry.
    pub fn new(bridge: impl Into<PathBuf>, dll: impl Into<String>) -> Self {
        Self {
            bridge: bridge.into(),
            args: Vec::new(),
            dll: dll.into(),
            proc: None,
        }
    }

    /// The bridge's in-memory loopback device: for tests only, never listed to users.
    pub fn loopback(bridge: impl Into<PathBuf>) -> Self {
        Self {
            bridge: bridge.into(),
            args: vec!["--loopback".into()],
            dll: j2534_bridge::serve::LOOPBACK_DLL.into(),
            proc: None,
        }
    }

    async fn call(&mut self, req: &Request, timeout: Duration) -> Result<Response> {
        let proc = self.proc.as_mut().ok_or(HalError::NotOpen)?;
        let mut line = serde_json::to_string(req).expect("requests serialize");
        line.push('\n');
        let exchange = async {
            proc.stdin.write_all(line.as_bytes()).await?;
            proc.stdin.flush().await?;
            let mut reply = String::new();
            if proc.stdout.read_line(&mut reply).await? == 0 {
                return Err(HalError::Protocol(
                    "J2534 bridge exited (driver crash?)".into(),
                ));
            }
            serde_json::from_str::<Response>(&reply)
                .map_err(|e| HalError::Protocol(format!("bridge reply {reply:?}: {e}")))
        };
        let response = tokio::time::timeout(timeout, exchange)
            .await
            .map_err(|_| HalError::Timeout(timeout))??;
        match response {
            Response::Error { message } => Err(HalError::Protocol(message)),
            other => Ok(other),
        }
    }

    async fn expect_ok(&mut self, req: &Request, timeout: Duration) -> Result<()> {
        match self.call(req, timeout).await? {
            Response::Ok => Ok(()),
            other => Err(HalError::Protocol(format!(
                "bridge answered {other:?} to {req:?}"
            ))),
        }
    }
}

#[async_trait]
impl VehicleBusAdapter for J2534Adapter {
    async fn open(&mut self, bitrate: u32) -> Result<()> {
        let mut child = Command::new(&self.bridge)
            .args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                HalError::Io(std::io::Error::new(
                    e.kind(),
                    format!("{}: {e}", self.bridge.display()),
                ))
            })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        self.proc = Some(Bridge {
            child,
            stdin,
            stdout,
        });

        match self.call(&Request::Hello, CALL_TIMEOUT).await? {
            Response::Hello {
                protocol,
                pointer_bits,
                version,
            } if protocol == BRIDGE_PROTOCOL => {
                tracing::info!(version, pointer_bits, "J2534 bridge started");
            }
            other => {
                return Err(HalError::Protocol(format!(
                    "incompatible J2534 bridge: {other:?}"
                )))
            }
        }
        let dll = self.dll.clone();
        self.expect_ok(&Request::Open { dll }, OPEN_TIMEOUT).await?;
        self.expect_ok(&Request::Connect { bitrate }, OPEN_TIMEOUT)
            .await
    }

    async fn set_filter(&mut self, filters: &[CanFilter]) -> Result<()> {
        let filters = filters
            .iter()
            .map(|f| Filter {
                id: f.id,
                mask: f.mask,
                extended: f.extended,
            })
            .collect();
        self.expect_ok(&Request::SetFilter { filters }, CALL_TIMEOUT)
            .await
    }

    async fn send_frame(&mut self, frame: &CanFrame) -> Result<()> {
        let req = Request::Send {
            id: frame.id(),
            extended: frame.is_extended(),
            data: proto::hex(frame.data()),
        };
        self.expect_ok(&req, CALL_TIMEOUT).await
    }

    async fn recv_frame(&mut self, timeout: Duration) -> Result<CanFrame> {
        let timeout_ms = timeout.as_millis().min(u128::from(u32::MAX)) as u32;
        match self
            .call(&Request::Recv { timeout_ms }, timeout + CALL_TIMEOUT)
            .await?
        {
            Response::Frame { id, extended, data } => {
                let data = proto::unhex(&data).map_err(HalError::Protocol)?;
                CanFrame::new(id, extended, &data)
            }
            Response::Timeout => Err(HalError::Timeout(timeout)),
            other => Err(HalError::Protocol(format!(
                "bridge answered {other:?} to recv"
            ))),
        }
    }

    async fn close(&mut self) -> Result<()> {
        if self.proc.is_none() {
            return Ok(());
        }
        let result = self.expect_ok(&Request::Close, CALL_TIMEOUT).await;
        if let Some(mut proc) = self.proc.take() {
            drop(proc.stdin); // EOF ends the bridge
            let _ = tokio::time::timeout(CALL_TIMEOUT, proc.child.wait()).await;
        }
        result
    }
}

/// Installed PassThru devices, as the bridge reads them from the registry.
pub fn list_devices(bridge: &Path) -> Result<Vec<DeviceInfo>> {
    use std::io::{BufRead, Write};
    let mut child = std::process::Command::new(bridge)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("piped stdin");
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(&Request::List).expect("serializes")
    )?;
    drop(stdin);
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().expect("piped stdout")).read_line(&mut line)?;
    let _ = child.wait();
    match serde_json::from_str(&line) {
        Ok(Response::Devices { devices }) => Ok(devices),
        Ok(other) => Err(HalError::Protocol(format!(
            "bridge answered {other:?} to list"
        ))),
        Err(e) => Err(HalError::Protocol(format!("bridge reply {line:?}: {e}"))),
    }
}

/// J2534 devices for adapter discovery (Windows).
#[cfg(windows)]
pub fn discover() -> Vec<super::discovery::DiscoveredAdapter> {
    use crate::protocol::messages::AdapterKind;
    match list_devices(&default_bridge_path()) {
        Ok(devices) => devices
            .into_iter()
            .enumerate()
            .map(|(i, d)| super::discovery::DiscoveredAdapter {
                adapter_id: format!("j2534-{i}"),
                kind: AdapterKind::J2534,
                display_name: format!("{} ({})", d.name, d.vendor),
                path: Some(d.dll),
            })
            .collect(),
        Err(e) => {
            tracing::warn!("J2534 discovery failed: {e}");
            Vec::new()
        }
    }
}
