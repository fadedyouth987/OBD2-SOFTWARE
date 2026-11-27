//! Local pairing codes (Task 1.4): `edge-daemon pair` prints a 6-digit code
//! the technician types into the app (or a native client sends in Hello).
//! Single use, valid 2 minutes. Only SHA-256 hashes are stored, in a file
//! readable by the user running the daemon (0600 on Unix), so the `pair`
//! command and the running daemon share codes without any network listener.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use sha2::{Digest, Sha256};

pub const CODE_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Entry {
    sha256: String,
    expires_at: u64,
}

/// Outstanding pairing codes.
pub struct PairingStore {
    path: Option<PathBuf>,
    memory: Mutex<Vec<Entry>>,
}

fn hash(code: &str) -> String {
    Sha256::digest(code.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Uniform 6-digit code from the OS random source.
fn random_code() -> String {
    loop {
        let mut b = [0u8; 4];
        getrandom::fill(&mut b).expect("OS random source available");
        let n = u32::from_le_bytes(b);
        // Rejection sampling keeps every code equally likely.
        if n < u32::MAX - (u32::MAX % 1_000_000) {
            return format!("{:06}", n % 1_000_000);
        }
    }
}

/// True for a 6-digit pairing code (as opposed to a JWT).
pub fn looks_like_code(token: &str) -> bool {
    token.len() == 6 && token.bytes().all(|b| b.is_ascii_digit())
}

impl PairingStore {
    pub fn in_memory() -> Self {
        Self {
            path: None,
            memory: Mutex::new(Vec::new()),
        }
    }

    /// File-backed store shared between `edge-daemon pair` and the daemon.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
            memory: Mutex::new(Vec::new()),
        }
    }

    fn load(&self) -> Vec<Entry> {
        match &self.path {
            None => self.memory.lock().expect("pairing lock").clone(),
            Some(p) => std::fs::read_to_string(p)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default(),
        }
    }

    fn save(&self, entries: &[Entry]) -> std::io::Result<()> {
        match &self.path {
            None => {
                *self.memory.lock().expect("pairing lock") = entries.to_vec();
                Ok(())
            }
            Some(p) => {
                if let Some(dir) = p.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                let tmp = p.with_extension("tmp");
                std::fs::write(&tmp, serde_json::to_vec(entries).expect("serializes"))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(file_mode(p)))?;
                }
                std::fs::rename(tmp, p)
            }
        }
    }

    /// Issues a new code valid for [`CODE_TTL`] from `now` (Unix seconds).
    pub fn issue(&self, now: u64) -> std::io::Result<String> {
        let mut entries: Vec<Entry> = self
            .load()
            .into_iter()
            .filter(|e| e.expires_at > now)
            .collect();
        let code = random_code();
        entries.push(Entry {
            sha256: hash(&code),
            expires_at: now + CODE_TTL.as_secs(),
        });
        self.save(&entries)?;
        Ok(code)
    }

    /// Consumes `code` if it is outstanding and unexpired. Single use.
    pub fn consume(&self, code: &str, now: u64) -> bool {
        if !looks_like_code(code) {
            return false;
        }
        let wanted = hash(code);
        let entries = self.load();
        let live: Vec<Entry> = entries
            .iter()
            .filter(|e| e.expires_at > now)
            .cloned()
            .collect();
        let found = live.iter().position(|e| e.sha256 == wanted);
        let mut remaining = live;
        if let Some(i) = found {
            remaining.remove(i);
        }
        if remaining.len() != entries.len() {
            if let Err(e) = self.save(&remaining) {
                tracing::error!("could not update pairing store: {e}");
                return false; // fail closed: a code we cannot burn is not accepted
            }
        }
        found.is_some()
    }
}

/// Owner-only, except in a shared install directory (setgid, as the Linux
/// package makes `/var/lib/obd2-edge`): there the daemon's user and the
/// technicians in its group must both read the file, so the group may too.
#[cfg(unix)]
fn file_mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    let shared = path
        .parent()
        .and_then(|d| std::fs::metadata(d).ok())
        .is_some_and(|m| m.permissions().mode() & 0o2000 != 0);
    if shared {
        0o660
    } else {
        0o600
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_single_use_and_expire() {
        let store = PairingStore::in_memory();
        let code = store.issue(1_000).unwrap();
        assert!(looks_like_code(&code));
        assert!(!store.consume("123456x", 1_000));
        assert!(store.consume(&code, 1_010));
        assert!(!store.consume(&code, 1_011), "reused code rejected");
        let late = store.issue(2_000).unwrap();
        assert!(
            !store.consume(&late, 2_000 + CODE_TTL.as_secs()),
            "expired after 2 minutes"
        );
    }

    #[test]
    #[cfg(unix)]
    fn group_readable_only_in_a_setgid_install_dir() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("edge-pairing-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o2770)).unwrap();
        let path = dir.join("pairing.json");
        PairingStore::at(&path).issue(5_000).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(&dir).unwrap();
        // The daemon's user and technicians in its group share the file; nobody else.
        assert_eq!(mode, 0o660);
    }

    #[test]
    fn file_store_is_shared_and_private() {
        let path = std::env::temp_dir().join(format!("edge-pairing-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let code = PairingStore::at(&path).issue(5_000).unwrap(); // `edge-daemon pair`
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains(&code), "only hashes on disk");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let daemon = PairingStore::at(&path);
        assert!(daemon.consume(&code, 5_030));
        assert!(!PairingStore::at(&path).consume(&code, 5_031));
        std::fs::remove_file(&path).unwrap();
    }
}
