//! Rotating local log file (Task 5.2, A-CEO-5).
//!
//! `<data dir>/logs/edge-daemon.log`, rotated at a size limit, keeping a few
//! old files (`edge-daemon.log.1` is the newest). Written through the normal
//! `tracing` subscriber so the file has the same structured lines as stderr.

use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

/// Default size at which the log rotates.
pub const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Default number of rotated files kept besides the live one.
pub const DEFAULT_KEEP: usize = 5;

pub const LOG_FILE_NAME: &str = "edge-daemon.log";

/// The directory logs live in.
pub fn log_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

/// A size-rotated log file. Wrap it in a `Mutex` to use it as a `tracing` writer.
pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    file: File,
    written: u64,
}

impl RotatingFile {
    pub fn open(dir: &Path, max_bytes: u64, keep: usize) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(LOG_FILE_NAME);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let written = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            path,
            max_bytes,
            keep: keep.max(1),
            file,
            written,
        })
    }

    fn rotated(&self, n: usize) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(format!(".{n}"));
        PathBuf::from(p)
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        let _ = fs::remove_file(self.rotated(self.keep));
        for n in (1..self.keep).rev() {
            let from = self.rotated(n);
            if from.exists() {
                fs::rename(&from, self.rotated(n + 1))?;
            }
        }
        fs::rename(&self.path, self.rotated(1))?;
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        self.written = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let n = self.file.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// Log files in `dir`, newest first (the live file, then `.1`, `.2`, …).
pub fn log_files(dir: &Path) -> Vec<PathBuf> {
    let live = dir.join(LOG_FILE_NAME);
    let mut out = Vec::new();
    if live.exists() {
        out.push(live.clone());
    }
    for n in 1..=50 {
        let mut p = live.clone().into_os_string();
        p.push(format!(".{n}"));
        let p = PathBuf::from(p);
        if !p.exists() {
            break;
        }
        out.push(p);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "edge-log-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rotates_at_the_limit_and_keeps_only_n_files() {
        let dir = tmp();
        let mut f = RotatingFile::open(&dir, 100, 2).unwrap();
        for i in 0..20 {
            writeln!(f, "line {i:02} padding padding padding").unwrap();
        }
        f.flush().unwrap();
        let files = log_files(&dir);
        assert_eq!(files.len(), 3, "live file plus 2 rotated: {files:?}");
        for p in &files {
            assert!(fs::metadata(p).unwrap().len() <= 100 + 40);
        }
        let newest = fs::read_to_string(&files[0]).unwrap();
        assert!(newest.contains("line 19"));
        fs::remove_dir_all(dir).unwrap();
    }
}
