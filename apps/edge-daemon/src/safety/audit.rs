//! Gated-command audit log (A-CEO-4): every gated attempt, allowed or refused,
//! and the ECU's answer to every gated request that was sent. Written locally
//! as JSON lines; Task 2.1/2.2 sync it to the cloud `audit_log` table.

use std::{fs::OpenOptions, io::Write, path::PathBuf, sync::Mutex};

/// What happened.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// Passed the interlock and was sent.
    Allowed,
    /// Refused by the interlock (code is the wire `ErrorCode`).
    Refused,
    /// The ECU's answer to an allowed request (`nrc` set when negative).
    Response,
    /// Ungated but logged by policy (e.g. UDS extended session).
    Logged,
    /// A safety token was issued or refused.
    TokenIssued,
    TokenRefused,
    /// Bench mode switched on or off.
    BenchMode,
}

/// One audit record.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct AuditEntry {
    pub at: String,
    pub session_id: String,
    pub user: Option<String>,
    /// Vehicle identity (VIN) when known.
    pub vehicle: Option<String>,
    /// e.g. "UDS 0x7E0/0x7E8".
    pub ecu: String,
    /// e.g. "0x2F InputOutputControlByIdentifier".
    pub service: String,
    pub tier: Option<char>,
    pub outcome: Outcome,
    /// Refusal code, when refused.
    pub code: Option<String>,
    pub nrc: Option<u8>,
    pub detail: String,
}

/// Where audit records go.
pub trait AuditSink: Send + Sync {
    fn record(&self, entry: AuditEntry);
}

/// Keeps records in memory (tests, and a buffer for the UI).
#[derive(Default)]
pub struct MemoryAudit {
    entries: Mutex<Vec<AuditEntry>>,
}

impl MemoryAudit {
    pub fn entries(&self) -> Vec<AuditEntry> {
        self.entries.lock().expect("audit lock").clone()
    }
}

impl AuditSink for MemoryAudit {
    fn record(&self, entry: AuditEntry) {
        self.entries.lock().expect("audit lock").push(entry);
    }
}

/// Appends one JSON object per line to a file. A write failure is logged loudly:
/// the record must not be lost silently, but the safety decision already stands.
pub struct JsonlAudit {
    path: PathBuf,
    lock: Mutex<()>,
}

impl JsonlAudit {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }
}

impl AuditSink for JsonlAudit {
    fn record(&self, entry: AuditEntry) {
        let _guard = self.lock.lock().expect("audit lock");
        let line = serde_json::to_string(&entry).expect("audit entries serialize");
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| writeln!(f, "{line}").and_then(|()| f.sync_data()));
        if let Err(e) = result {
            tracing::error!(path = %self.path.display(), "audit log write failed: {e}; record: {line}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(outcome: Outcome) -> AuditEntry {
        AuditEntry {
            at: "2026-11-19T06:00:00.000Z".into(),
            session_id: "s1".into(),
            user: Some("tech-1".into()),
            vehicle: None,
            ecu: "UDS 0x7E0/0x7E8".into(),
            service: "0x2F InputOutputControlByIdentifier".into(),
            tier: Some('A'),
            outcome,
            code: None,
            nrc: None,
            detail: String::new(),
        }
    }

    #[test]
    fn jsonl_appends_lines() {
        let path = std::env::temp_dir().join(format!("edge-audit-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let sink = JsonlAudit::new(&path);
        sink.record(entry(Outcome::Allowed));
        sink.record(entry(Outcome::Refused));
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["outcome"], "refused");
        assert_eq!(lines[0]["tier"], "A");
        std::fs::remove_file(&path).unwrap();
    }
}
