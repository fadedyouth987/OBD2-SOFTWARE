//! SQLite WAL ring buffer for telemetry (Task 1.3, A-ENG-9).
//!
//! - Persists `CanFrameBatch` and `ObdPidStream` messages so a session
//!   survives being offline; each stream has a sync watermark (the last row id
//!   the cloud acknowledged, Task 2.2).
//! - Capped (default 2 GB of logical row size). When a write would exceed the
//!   cap, the oldest *synced* rows are evicted first. Unsynced rows are never
//!   evicted: if only unsynced data remains, the write is refused with
//!   [`StorageError::Full`] so the caller can warn the technician instead of
//!   silently losing data.
//! - WAL journal with `synchronous=NORMAL`: durable across crashes, fast enough
//!   for 20+ Hz streams.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    hal::parse_hex,
    protocol::messages::{CanFrameBatch, ObdPidStream},
};

/// A-ENG-9 default cap.
pub const DEFAULT_CAP_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Logical size of a row beyond its payload (ids, timestamps, index entries).
const ROW_OVERHEAD: u64 = 48;
const EVICT_CHUNK: i64 = 1_000;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(
        "ring buffer full of unsynced data ({used} of {cap} bytes); sync before recording more"
    )]
    Full { used: u64, cap: u64 },
    #[error("invalid record: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StorageError>;

/// Which telemetry stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stream {
    CanFrames,
    PidSamples,
}

impl Stream {
    fn table(self) -> &'static str {
        match self {
            Self::CanFrames => "can_frames",
            Self::PidSamples => "pid_samples",
        }
    }

    fn key(self) -> &'static str {
        self.table()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredFrame {
    pub row_id: i64,
    pub session_id: String,
    pub timestamp_us: u64,
    pub can_id: u32,
    pub extended: bool,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredSample {
    pub row_id: i64,
    pub session_id: String,
    pub timestamp_us: u64,
    pub pid: u16,
    pub name: String,
    pub value: f64,
    pub unit: String,
}

pub struct RingBuffer {
    conn: Connection,
    cap: u64,
    used: u64,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS can_frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp_us INTEGER NOT NULL,
    can_id INTEGER NOT NULL,
    is_extended INTEGER NOT NULL,
    data BLOB NOT NULL,
    bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pid_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp_us INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    name TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_watermarks (
    stream TEXT PRIMARY KEY,
    last_synced_id INTEGER NOT NULL
);
";

impl RingBuffer {
    /// Opens (or creates) the buffer at `path` in WAL mode.
    pub fn open(path: &Path, cap_bytes: u64) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::init(conn, cap_bytes)
    }

    /// In-memory buffer (tests and ephemeral sessions).
    pub fn in_memory(cap_bytes: u64) -> Result<Self> {
        Self::init(Connection::open_in_memory()?, cap_bytes)
    }

    fn init(conn: Connection, cap: u64) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        let used: i64 = conn.query_row(
            "SELECT (SELECT COALESCE(SUM(bytes), 0) FROM can_frames) + (SELECT COALESCE(SUM(bytes), 0) FROM pid_samples)",
            [],
            |r| r.get(0),
        )?;
        Ok(Self {
            conn,
            cap,
            used: used as u64,
        })
    }

    pub fn journal_mode(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))?)
    }

    pub fn used_bytes(&self) -> u64 {
        self.used
    }

    pub fn cap_bytes(&self) -> u64 {
        self.cap
    }

    pub fn watermark(&self, stream: Stream) -> Result<i64> {
        Ok(self
            .conn
            .query_row(
                "SELECT last_synced_id FROM sync_watermarks WHERE stream = ?1",
                [stream.key()],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    /// Records that the cloud has every row up to `row_id`. Never moves backwards.
    pub fn mark_synced(&mut self, stream: Stream, row_id: i64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO sync_watermarks (stream, last_synced_id) VALUES (?1, ?2)
             ON CONFLICT(stream) DO UPDATE SET last_synced_id = MAX(last_synced_id, excluded.last_synced_id)",
            params![stream.key(), row_id],
        )?;
        Ok(())
    }

    /// (all rows, unsynced rows) in a stream.
    pub fn counts(&self, stream: Stream) -> Result<(u64, u64)> {
        let wm = self.watermark(stream)?;
        let sql = format!(
            "SELECT COUNT(*), COALESCE(SUM(id > ?1), 0) FROM {}",
            stream.table()
        );
        let (all, unsynced): (i64, i64) = self
            .conn
            .query_row(&sql, [wm], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok((all as u64, unsynced as u64))
    }

    /// Evicts the oldest synced rows until `need` more bytes fit.
    fn make_room(&mut self, need: u64) -> Result<()> {
        if need > self.cap {
            return Err(StorageError::Full {
                used: self.used,
                cap: self.cap,
            });
        }
        while self.used + need > self.cap {
            // The stream whose oldest synced row is older goes first.
            let mut oldest: Option<(Stream, i64)> = None;
            for stream in [Stream::CanFrames, Stream::PidSamples] {
                let wm = self.watermark(stream)?;
                let sql = format!(
                    "SELECT MIN(timestamp_us) FROM {} WHERE id <= ?1",
                    stream.table()
                );
                let ts: Option<i64> = self.conn.query_row(&sql, [wm], |r| r.get(0))?;
                if let Some(ts) = ts {
                    if oldest.is_none_or(|(_, t)| ts < t) {
                        oldest = Some((stream, ts));
                    }
                }
            }
            let Some((stream, _)) = oldest else {
                return Err(StorageError::Full {
                    used: self.used,
                    cap: self.cap,
                });
            };
            let wm = self.watermark(stream)?;
            let table = stream.table();
            let tx = self.conn.transaction()?;
            let freed: i64 = tx.query_row(
                &format!(
                    "SELECT COALESCE(SUM(bytes), 0) FROM (SELECT bytes FROM {table} WHERE id <= ?1 ORDER BY id LIMIT ?2)"
                ),
                params![wm, EVICT_CHUNK],
                |r| r.get(0),
            )?;
            tx.execute(
                &format!("DELETE FROM {table} WHERE id IN (SELECT id FROM {table} WHERE id <= ?1 ORDER BY id LIMIT ?2)"),
                params![wm, EVICT_CHUNK],
            )?;
            tx.commit()?;
            self.used = self.used.saturating_sub(freed as u64);
            tracing::debug!(table, freed, "ring buffer evicted synced rows");
        }
        Ok(())
    }

    /// Stores one `CanFrameBatch` atomically. Returns the number of rows.
    pub fn append_can(&mut self, session_id: &str, batch: &CanFrameBatch) -> Result<usize> {
        let rows: Vec<(u64, u32, bool, Vec<u8>)> = batch
            .frames
            .iter()
            .map(|f| {
                Ok((
                    f.timestamp_us.0,
                    f.can_id.0,
                    f.is_extended,
                    parse_hex(&f.data_hex).map_err(|e| StorageError::Invalid(e.to_string()))?,
                ))
            })
            .collect::<Result<_>>()?;
        let need: u64 = rows.iter().map(|r| ROW_OVERHEAD + r.3.len() as u64).sum();
        self.make_room(need)?;
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO can_frames (session_id, timestamp_us, can_id, is_extended, data, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (ts, id, ext, data) in &rows {
                stmt.execute(params![
                    session_id,
                    *ts as i64,
                    id,
                    ext,
                    data,
                    (ROW_OVERHEAD + data.len() as u64) as i64
                ])?;
            }
        }
        tx.commit()?;
        self.used += need;
        Ok(rows.len())
    }

    /// Stores one `ObdPidStream` atomically. Returns the number of rows.
    pub fn append_pids(&mut self, session_id: &str, stream: &ObdPidStream) -> Result<usize> {
        let cost =
            |name: &str, unit: &str| ROW_OVERHEAD + 8 + name.len() as u64 + unit.len() as u64;
        let need: u64 = stream.samples.iter().map(|s| cost(&s.name, &s.unit)).sum();
        self.make_room(need)?;
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare_cached(
                "INSERT INTO pid_samples (session_id, timestamp_us, pid, name, value, unit, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for s in &stream.samples {
                stmt.execute(params![
                    session_id,
                    s.timestamp_us.0 as i64,
                    s.pid,
                    s.name.as_str(),
                    s.value,
                    s.unit.as_str(),
                    cost(&s.name, &s.unit) as i64
                ])?;
            }
        }
        tx.commit()?;
        self.used += need;
        Ok(stream.samples.len())
    }

    /// Up to `limit` CAN rows after the watermark, oldest first.
    pub fn unsynced_frames(&self, limit: usize) -> Result<Vec<StoredFrame>> {
        let wm = self.watermark(Stream::CanFrames)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, session_id, timestamp_us, can_id, is_extended, data FROM can_frames WHERE id > ?1 ORDER BY id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![wm, limit as i64], |r| {
            Ok(StoredFrame {
                row_id: r.get(0)?,
                session_id: r.get(1)?,
                timestamp_us: r.get::<_, i64>(2)? as u64,
                can_id: r.get(3)?,
                extended: r.get(4)?,
                data: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Up to `limit` PID rows after the watermark, oldest first.
    pub fn unsynced_samples(&self, limit: usize) -> Result<Vec<StoredSample>> {
        let wm = self.watermark(Stream::PidSamples)?;
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, session_id, timestamp_us, pid, name, value, unit FROM pid_samples WHERE id > ?1 ORDER BY id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![wm, limit as i64], |r| {
            Ok(StoredSample {
                row_id: r.get(0)?,
                session_id: r.get(1)?,
                timestamp_us: r.get::<_, i64>(2)? as u64,
                pid: r.get(3)?,
                name: r.get(4)?,
                value: r.get(5)?,
                unit: r.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{self, messages::EdgeMessage};

    fn can_batch(start_us: u64, n: u64) -> CanFrameBatch {
        let frames: Vec<serde_json::Value> = (0..n)
            .map(|i| serde_json::json!({"timestamp_us": start_us + i, "can_id": 0x7E8, "is_extended": false, "dlc": 8, "data_hex": "0102030405060708"}))
            .collect();
        match protocol::parse_message(
            &serde_json::json!({"type": "CanFrameBatch", "frames": frames}).to_string(),
        )
        .unwrap()
        {
            EdgeMessage::CanFrameBatch(b) => b,
            _ => unreachable!(),
        }
    }

    fn pid_stream(ts: u64) -> ObdPidStream {
        let msg = serde_json::json!({"type": "ObdPidStream", "samples": [
            {"timestamp_us": ts, "pid": 12, "name": "Engine speed", "value": 812.5, "unit": "rpm"},
            {"timestamp_us": ts, "pid": 13, "name": "Vehicle speed", "value": 0.0, "unit": "km/h"}
        ]});
        match protocol::parse_message(&msg.to_string()).unwrap() {
            EdgeMessage::ObdPidStream(s) => s,
            _ => unreachable!(),
        }
    }

    const FRAME_COST: u64 = ROW_OVERHEAD + 8;

    #[test]
    fn persists_in_wal_mode_with_watermarks() {
        let path = std::env::temp_dir().join(format!("edge-ring-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mut rb = RingBuffer::open(&path, DEFAULT_CAP_BYTES).unwrap();
            assert_eq!(rb.journal_mode().unwrap(), "wal");
            assert_eq!(rb.append_can("s1", &can_batch(1_000, 5)).unwrap(), 5);
            assert_eq!(rb.append_pids("s1", &pid_stream(2_000)).unwrap(), 2);
            let frames = rb.unsynced_frames(3).unwrap();
            assert_eq!(frames.len(), 3);
            assert_eq!(frames[0].data, vec![1, 2, 3, 4, 5, 6, 7, 8]);
            rb.mark_synced(Stream::CanFrames, frames[2].row_id).unwrap();
            rb.mark_synced(Stream::CanFrames, 1).unwrap(); // never moves backwards
        }
        // Survives a reopen: rows, usage and watermark.
        let rb = RingBuffer::open(&path, DEFAULT_CAP_BYTES).unwrap();
        assert_eq!(rb.counts(Stream::CanFrames).unwrap(), (5, 2));
        assert_eq!(rb.watermark(Stream::CanFrames).unwrap(), 3);
        assert_eq!(rb.unsynced_frames(10).unwrap().len(), 2);
        assert_eq!(rb.unsynced_samples(10).unwrap()[0].value, 812.5);
        assert!(rb.used_bytes() >= 5 * FRAME_COST);
        drop(rb);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    /// A-ENG-9 gate: the cap evicts the oldest synced rows and never unsynced ones.
    #[test]
    fn cap_evicts_oldest_synced_never_unsynced() {
        let mut rb = RingBuffer::in_memory(10 * FRAME_COST).unwrap();
        rb.append_can("s1", &can_batch(0, 10)).unwrap();
        assert_eq!(rb.used_bytes(), 10 * FRAME_COST);
        // Nothing synced yet: a further write is refused, nothing is lost.
        assert!(matches!(
            rb.append_can("s1", &can_batch(100, 1)),
            Err(StorageError::Full { .. })
        ));
        assert_eq!(rb.counts(Stream::CanFrames).unwrap(), (10, 10));

        // Sync the first 4, then write 3 more: the 3 oldest synced rows go.
        let first = rb.unsynced_frames(4).unwrap();
        rb.mark_synced(Stream::CanFrames, first[3].row_id).unwrap();
        rb.append_can("s1", &can_batch(100, 3)).unwrap();
        assert!(rb.used_bytes() <= rb.cap_bytes());
        let (all, unsynced) = rb.counts(Stream::CanFrames).unwrap();
        assert_eq!(unsynced, 9, "6 old unsynced + 3 new, all kept");
        assert!(all <= 10);
        let remaining: Vec<u64> = rb
            .unsynced_frames(20)
            .unwrap()
            .iter()
            .map(|f| f.timestamp_us)
            .collect();
        assert_eq!(remaining, vec![4, 5, 6, 7, 8, 9, 100, 101, 102]);

        // Larger than the whole cap: refused outright.
        assert!(matches!(
            rb.append_can("s1", &can_batch(200, 11)),
            Err(StorageError::Full { .. })
        ));
    }

    #[test]
    fn eviction_takes_the_older_stream_first() {
        let pid_cost = ROW_OVERHEAD
            + 8
            + "Engine speed".len() as u64
            + 3
            + ROW_OVERHEAD
            + 8
            + "Vehicle speed".len() as u64
            + 4;
        let mut rb = RingBuffer::in_memory(4 * FRAME_COST + pid_cost).unwrap();
        rb.append_pids("s1", &pid_stream(10)).unwrap(); // oldest
        rb.append_can("s1", &can_batch(50, 4)).unwrap();
        rb.mark_synced(Stream::PidSamples, i64::MAX).unwrap();
        rb.mark_synced(Stream::CanFrames, i64::MAX).unwrap();
        rb.append_can("s1", &can_batch(90, 1)).unwrap();
        assert_eq!(
            rb.counts(Stream::PidSamples).unwrap().0,
            0,
            "older PID rows evicted first"
        );
        assert_eq!(rb.counts(Stream::CanFrames).unwrap().0, 5);
    }
}
