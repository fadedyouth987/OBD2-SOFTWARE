//! Local pairing codes (Task 1.4): `edge-daemon pair` prints a 6-digit code
//! the technician types into the app (or a native client sends in Hello).
//! Single use, valid 2 minutes. Only SHA-256 hashes are stored, in
//! `<data dir>/pairing/pairing.json` ([`pairing_path`]), so the `pair` command
//! and the running daemon share codes without any network listener. The file
//! is 0600 on Unix, or 0660 when its folder is setgid: the installed service
//! shares only that `pairing/` folder with technicians (Task 5.1), never the
//! rest of its data (leases, audit log).
//!
//! Guessing is cut off: after [`MAX_MISSES`] wrong codes every outstanding code
//! is cancelled, so no code ever faces more than [`MAX_MISSES`] guesses (odds of
//! a hit: 5 in a million). A code issued afterwards works at once: there is no
//! lockout window, so another local process can't keep everyone from pairing by
//! sending a few wrong codes every so often (review L3). To block pairing now it
//! has to cancel each fresh code as it is issued, which is logged every time.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use sha2::{Digest, Sha256};

pub const CODE_TTL: Duration = Duration::from_secs(120);
/// Wrong codes (from any connection) before every outstanding code is cancelled.
pub const MAX_MISSES: u32 = 5;

/// What happened to a code sent in Hello.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consumed {
    Paired,
    /// Wrong, expired or already used.
    Refused,
    /// Wrong, and it was the miss that cancelled every outstanding code.
    CancelledAll,
}

/// Where the pairing codes for the data directory `dir` live.
pub fn pairing_path(dir: &Path) -> PathBuf {
    dir.join("pairing").join("pairing.json")
}

#[derive(Default)]
struct Guard {
    misses: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Entry {
    sha256: String,
    expires_at: u64,
}

/// Outstanding pairing codes.
pub struct PairingStore {
    path: Option<PathBuf>,
    memory: Mutex<Vec<Entry>>,
    guard: Mutex<Guard>,
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
            guard: Mutex::default(),
        }
    }

    /// File-backed store shared between `edge-daemon pair` and the daemon.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: Some(path.into()),
            memory: Mutex::new(Vec::new()),
            guard: Mutex::default(),
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
            Some(p) => crate::fsutil::write_atomic(
                p,
                &serde_json::to_vec(entries).expect("serializes"),
                file_mode(p),
            ),
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
        self.try_consume(code, now) == Consumed::Paired
    }

    /// Like [`Self::consume`], and says whether this miss cancelled every code.
    pub fn try_consume(&self, code: &str, now: u64) -> Consumed {
        if !looks_like_code(code) {
            return Consumed::Refused;
        }
        // The guard is held across the check so concurrent guesses can't
        // overshoot the miss budget.
        let mut g = self.guard.lock().expect("pairing guard");
        if self.take(code, now) {
            g.misses = 0;
            return Consumed::Paired;
        }
        g.misses += 1;
        if g.misses < MAX_MISSES {
            return Consumed::Refused;
        }
        g.misses = 0;
        tracing::warn!(
            "{MAX_MISSES} wrong pairing codes: every outstanding code cancelled. If this keeps \
             happening, another program on this computer is guessing codes"
        );
        if let Err(e) = self.save(&[]) {
            tracing::error!("could not cancel outstanding pairing codes: {e}");
        }
        Consumed::CancelledAll
    }

    fn take(&self, code: &str, now: u64) -> bool {
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

/// Owner-only, except in a shared pairing folder (setgid, as the Linux package
/// makes `/var/lib/obd2-edge/pairing`): there the daemon's user and the
/// technicians in its group must both read the file, so the group may too.
#[cfg(not(unix))]
fn file_mode(_path: &Path) -> u32 {
    0o600
}

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
    fn group_readable_only_in_a_setgid_pairing_dir() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("edge-pairing-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o2770)).unwrap();
        let path = dir.join("pairing.json");
        PairingStore::at(&path).issue(5_000).unwrap();
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "no temp files left"
        );
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        std::fs::remove_dir_all(&dir).unwrap();
        // The daemon's user and technicians in its group share the file; nobody else.
        assert_eq!(mode, 0o660);
    }

    #[test]
    fn five_wrong_codes_cancel_every_code_but_a_fresh_one_works_at_once() {
        let store = PairingStore::in_memory();
        let good = store.issue(1_000).unwrap();
        let wrong = if good == "000000" { "111111" } else { "000000" };
        for _ in 0..MAX_MISSES - 1 {
            assert_eq!(store.try_consume(wrong, 1_001), Consumed::Refused);
        }
        assert_eq!(store.try_consume(wrong, 1_001), Consumed::CancelledAll);
        // The code that was live during the guessing is gone for good...
        assert!(!store.consume(&good, 1_002));
        // ...but there is no lockout window to sit out (review L3).
        let fresh = store.issue(1_003).unwrap();
        assert!(store.consume(&fresh, 1_003));
    }

    #[test]
    fn no_code_faces_more_than_max_misses_guesses() {
        let store = PairingStore::in_memory();
        let mut guesses_while_live = 0;
        let code = store.issue(1_000).unwrap();
        let wrong = if code == "000000" { "111111" } else { "000000" };
        loop {
            guesses_while_live += 1;
            if store.try_consume(wrong, 1_000) == Consumed::CancelledAll {
                break;
            }
        }
        assert_eq!(guesses_while_live, MAX_MISSES);
        assert!(!store.consume(&code, 1_000));
    }

    #[test]
    fn a_hit_resets_the_miss_count() {
        let store = PairingStore::in_memory();
        for i in 0..3u64 {
            let code = store.issue(1_000 + i).unwrap();
            let wrong = if code == "000000" { "111111" } else { "000000" };
            for _ in 0..MAX_MISSES - 1 {
                assert!(!store.consume(wrong, 1_000 + i));
            }
            assert!(store.consume(&code, 1_000 + i), "round {i}");
        }
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
