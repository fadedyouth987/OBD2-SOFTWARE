//! `edge-daemon diagnostics`: a redacted support bundle (Task 5.2, A-CEO-5).
//!
//! One JSON file with the daemon, protocol and policy versions, the adapters
//! found on this computer, the last 100 gated-command audit rows and the tail
//! of the log. Everything passes through [`redact`]: VIN serials (the last six
//! characters), bearer tokens and JWTs, and long hex strings (keys, token
//! hashes) are removed. Lease files and pairing codes are never read.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::{json, Value};

use crate::{hal::discovery::DiscoveredAdapter, protocol};

use super::logfile;

/// Audit rows included (the contract asks for the last 100).
pub const AUDIT_ROWS: usize = 100;
/// Log lines included from the newest files.
pub const LOG_LINES: usize = 2000;

/// Removes VIN serials, tokens and keys from free text.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric()
                    || chars[i] == '-'
                    || chars[i] == '_'
                    || chars[i] == '.')
            {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            out.push_str(&redact_word(&word));
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

fn redact_word(word: &str) -> String {
    // JWT / JWS: three base64url parts, header starts with `eyJ` (`{"`).
    if word.starts_with("eyJ") && word.matches('.').count() >= 2 {
        return "[redacted-token]".into();
    }
    // Trailing sentence punctuation stays outside the checks below.
    let core = word.trim_end_matches('.');
    let tail = &word[core.len()..];
    if core.len() >= 32 && core.chars().all(|c| c.is_ascii_hexdigit()) {
        return format!("[redacted-hex]{tail}");
    }
    if is_vin(core) {
        return format!("{}******{tail}", &core[..11]);
    }
    word.to_string()
}

/// A 17-character VIN: letters and digits, never I, O or Q, with both kinds present.
fn is_vin(s: &str) -> bool {
    s.len() == 17
        && s.chars()
            .all(|c| c.is_ascii_digit() || (c.is_ascii_uppercase() && !"IOQ".contains(c)))
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().any(|c| c.is_ascii_uppercase())
}

fn tail_lines(path: &Path, n: usize) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..]
        .iter()
        .map(|l| redact(l))
        .collect()
}

/// Builds the bundle from the data directory and the adapters found now.
pub fn build(data_dir: &Path, adapters: &[DiscoveredAdapter], generated_at: &str) -> Value {
    let audit: Vec<Value> = tail_lines(&data_dir.join("audit.jsonl"), AUDIT_ROWS)
        .into_iter()
        .map(|l| serde_json::from_str(&l).unwrap_or(Value::String(l)))
        .collect();
    let mut log = Vec::new();
    for file in logfile::log_files(&logfile::log_dir(data_dir)) {
        if log.len() >= LOG_LINES {
            break;
        }
        let mut lines = tail_lines(&file, LOG_LINES - log.len());
        lines.append(&mut log);
        log = lines;
    }
    json!({
        "kind": "obd2-edge-support-bundle",
        "generated_at": generated_at,
        "versions": {
            "daemon": env!("CARGO_PKG_VERSION"),
            "protocol": protocol::PROTOCOL_VERSION,
            "safety_policy": protocol::policy_version(),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
        "adapters": adapters.iter().map(|a| json!({
            "adapter_id": redact(&a.adapter_id),
            "kind": format!("{:?}", a.kind),
            "display_name": redact(&a.display_name),
            "path": a.path.as_deref().map(redact),
        })).collect::<Vec<_>>(),
        "audit_last_100": audit,
        "log_tail": log,
        "redaction": "VIN serials, tokens and long hex strings removed; leases and pairing codes not included",
    })
}

/// Writes the bundle and returns its path.
pub fn write(
    data_dir: &Path,
    out: Option<PathBuf>,
    adapters: &[DiscoveredAdapter],
    stamp: u64,
) -> std::io::Result<PathBuf> {
    let path = out.unwrap_or_else(|| data_dir.join(format!("support-bundle-{stamp}.json")));
    let bundle = build(data_dir, adapters, &stamp.to_string());
    fs::write(
        &path,
        serde_json::to_vec_pretty(&bundle).map_err(std::io::Error::other)?,
    )?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::messages::AdapterKind;

    const VIN: &str = "WBAPH5C55BA123456";
    const JWT: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJl";
    const KEY: &str = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";

    #[test]
    fn redacts_vin_serials_tokens_and_keys() {
        let text = format!("vehicle {VIN}. token={JWT} key {KEY} rpm 780 module DME P0301");
        let out = redact(&text);
        assert!(!out.contains("123456"), "{out}");
        assert!(out.contains("WBAPH5C55BA******."));
        assert!(!out.contains(JWT) && out.contains("[redacted-token]"));
        assert!(!out.contains(KEY) && out.contains("[redacted-hex]"));
        assert!(
            out.contains("rpm 780 module DME P0301"),
            "ordinary text kept: {out}"
        );
    }

    #[test]
    fn bundle_has_versions_last_100_audit_rows_and_no_secrets() {
        let dir = std::env::temp_dir().join(format!("edge-bundle-{}", std::process::id()));
        fs::create_dir_all(logfile::log_dir(&dir)).unwrap();
        let mut audit = String::new();
        for i in 0..150 {
            audit.push_str(&format!(
                "{{\"seq\":{i},\"vehicle\":\"{VIN}\",\"detail\":\"Bearer {JWT}\"}}\n"
            ));
        }
        fs::write(dir.join("audit.jsonl"), audit).unwrap();
        fs::write(
            logfile::log_dir(&dir).join(logfile::LOG_FILE_NAME),
            format!("paired {KEY}\n"),
        )
        .unwrap();
        fs::write(dir.join("lease.jwt"), JWT).unwrap();
        let adapters = vec![DiscoveredAdapter {
            adapter_id: "virtual-generic".into(),
            kind: AdapterKind::Virtual,
            display_name: "Virtual".into(),
            path: None,
        }];
        let path = write(&dir, None, &adapters, 42).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let bundle: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            bundle["audit_last_100"].as_array().unwrap().len(),
            AUDIT_ROWS
        );
        assert_eq!(bundle["audit_last_100"][0]["seq"], 50);
        assert_eq!(bundle["versions"]["daemon"], env!("CARGO_PKG_VERSION"));
        assert_eq!(bundle["adapters"][0]["adapter_id"], "virtual-generic");
        assert!(
            !text.contains("123456") && !text.contains(JWT) && !text.contains(KEY),
            "{text}"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
