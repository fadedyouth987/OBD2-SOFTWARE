//! Atomic, private file writes for daemon state (leases, pairing codes).
//!
//! Each write goes to a fresh temp file beside the target, named with the
//! process id and random bytes and opened with `create_new` (`O_CREAT|O_EXCL`),
//! so nothing another user pre-creates (a file or a symlink at a predictable
//! name) is ever written through. On Unix the mode is set on the open file, not on the path, then the
//! temp file is synced and renamed over the target.

use std::{
    io::Write,
    path::{Path, PathBuf},
};

fn temp_beside(path: &Path) -> PathBuf {
    let mut r = [0u8; 8];
    getrandom::fill(&mut r).expect("OS random source available");
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("state");
    let tag: String = r.iter().map(|b| format!("{b:02x}")).collect();
    path.with_file_name(format!(".{name}.{}.{tag}.tmp", std::process::id()))
}

/// Writes `data` to `path` atomically with Unix permission bits `mode`
/// (ignored on Windows, where the folder's ACL applies).
pub fn write_atomic(path: &Path, data: &[u8], mode: u32) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = temp_beside(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_CREAT|O_EXCL: fails on any existing file, symlinks included.
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let result = (|| {
        let mut f = opts.open(&tmp)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The umask may have narrowed the mode given to open(2).
            f.set_permissions(std::fs::Permissions::from_mode(mode))?;
        }
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_atomically_with_the_mode_and_leaves_no_temp_files() {
        let dir = std::env::temp_dir().join(format!("edge-fsutil-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("lease.jwt");
        write_atomic(&path, b"one", 0o600).unwrap();
        write_atomic(&path, b"two", 0o600).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["lease.jwt".to_owned()]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn temp_names_are_unpredictable() {
        let p = Path::new("/x/lease.jwt");
        assert_ne!(temp_beside(p), temp_beside(p));
    }
}
