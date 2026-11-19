//! Serial byte links for SLCAN, STN/ELM and K+DCAN adapters.
//!
//! [`SystemSerial`] is a real port (serialport crate, run on the blocking pool).
//! [`ReplaySerial`] replays a recorded exchange: it checks every byte the adapter
//! writes against the recording and feeds back the device's bytes. The adapter's
//! protocol code is the production code either way (Rule 2).
//!
//! Recording format (`fixtures/hal/*.txt`), one step per line:
//!
//! ```text
//! # comment
//! > ATZ\r                tester writes (escapes: \r \n \t \\ \xHH)
//! < ELM327 v1.4b\r\r>    device replies
//! >x 81 12 F1 81 05      tester writes, as hex
//! <x 83 F1 12 C1 EF 8F C5  device replies, as hex
//! ! break on             tester drives the line low (K-line init)
//! ! break off
//! ! baud 10400
//! ```

use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;

use super::{parse_hex, HalError, Result};

/// A byte-level serial connection.
#[async_trait]
pub trait SerialLink: Send {
    async fn write_all(&mut self, bytes: &[u8]) -> Result<()>;
    /// Reads at least one byte, waiting up to `timeout`; `Timeout` if none arrive.
    async fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize>;
    /// Holds the TX line low (`true`) or releases it, for K-line wake-up patterns.
    async fn set_break(&mut self, on: bool) -> Result<()>;
    async fn set_baud(&mut self, baud: u32) -> Result<()>;
    /// Drops unread input.
    async fn clear_input(&mut self) -> Result<()>;
}

/// A real serial port.
pub struct SystemSerial {
    port: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
}

impl SystemSerial {
    pub fn open(path: &str, baud: u32) -> Result<Self> {
        let port = serialport::new(path, baud)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| HalError::Io(std::io::Error::other(format!("{path}: {e}"))))?;
        Ok(Self {
            port: Arc::new(Mutex::new(port)),
        })
    }

    async fn blocking<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut dyn serialport::SerialPort) -> Result<T> + Send + 'static,
    {
        let port = Arc::clone(&self.port);
        tokio::task::spawn_blocking(move || {
            let mut guard = port
                .lock()
                .map_err(|_| HalError::Protocol("serial lock poisoned".into()))?;
            f(guard.as_mut())
        })
        .await
        .map_err(|e| HalError::Io(std::io::Error::other(e)))?
    }
}

fn sp_err(e: serialport::Error) -> HalError {
    HalError::Io(std::io::Error::other(e))
}

#[async_trait]
impl SerialLink for SystemSerial {
    async fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        let bytes = bytes.to_vec();
        self.blocking(move |port| {
            port.write_all(&bytes)?;
            port.flush()?;
            Ok(())
        })
        .await
    }

    async fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        let len = buf.len();
        let data = self
            .blocking(move |port| {
                port.set_timeout(timeout).map_err(sp_err)?;
                let mut tmp = vec![0u8; len];
                match port.read(&mut tmp) {
                    Ok(0) => Err(HalError::Timeout(timeout)),
                    Ok(n) => {
                        tmp.truncate(n);
                        Ok(tmp)
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                        Err(HalError::Timeout(timeout))
                    }
                    Err(e) => Err(e.into()),
                }
            })
            .await?;
        buf[..data.len()].copy_from_slice(&data);
        Ok(data.len())
    }

    async fn set_break(&mut self, on: bool) -> Result<()> {
        self.blocking(move |port| {
            if on {
                port.set_break()
            } else {
                port.clear_break()
            }
            .map_err(sp_err)
        })
        .await
    }

    async fn set_baud(&mut self, baud: u32) -> Result<()> {
        self.blocking(move |port| port.set_baud_rate(baud).map_err(sp_err))
            .await
    }

    async fn clear_input(&mut self) -> Result<()> {
        self.blocking(|port| port.clear(serialport::ClearBuffer::Input).map_err(sp_err))
            .await
    }
}

/// One step of a recorded exchange.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Write(Vec<u8>),
    Read(Vec<u8>),
    Break(bool),
    Baud(u32),
}

/// Replays a recorded exchange, checking the adapter's writes against it.
#[derive(Debug)]
pub struct ReplaySerial {
    steps: VecDeque<Step>,
    pending_write: Vec<u8>,
    line: usize,
}

impl ReplaySerial {
    pub fn new(steps: Vec<Step>) -> Self {
        Self {
            steps: steps.into(),
            pending_write: Vec::new(),
            line: 0,
        }
    }

    /// Parses the recording format described in the module docs.
    pub fn from_script(script: &str) -> Result<Self> {
        let mut steps = Vec::new();
        for (n, raw) in script.lines().enumerate() {
            let line = raw.trim_end();
            if line.trim().is_empty() || line.trim_start().starts_with('#') {
                continue;
            }
            let bad =
                |why: &str| HalError::Protocol(format!("script line {}: {why}: {raw:?}", n + 1));
            let (tag, rest) = line.split_once(' ').unwrap_or((line, ""));
            let step = match tag {
                ">" => Step::Write(unescape(rest).map_err(|e| bad(&e))?),
                "<" => Step::Read(unescape(rest).map_err(|e| bad(&e))?),
                ">x" => Step::Write(parse_hex(rest).map_err(|_| bad("bad hex"))?),
                "<x" => Step::Read(parse_hex(rest).map_err(|_| bad("bad hex"))?),
                "!" => match rest.split_whitespace().collect::<Vec<_>>().as_slice() {
                    ["break", "on"] => Step::Break(true),
                    ["break", "off"] => Step::Break(false),
                    ["baud", rate] => Step::Baud(rate.parse().map_err(|_| bad("bad baud"))?),
                    _ => return Err(bad("unknown directive")),
                },
                _ => return Err(bad("unknown tag")),
            };
            steps.push(step);
        }
        Ok(Self::new(steps))
    }

    /// True once every recorded step has been consumed.
    pub fn is_finished(&self) -> bool {
        self.steps.is_empty() && self.pending_write.is_empty()
    }

    /// Steps not yet consumed, for test failure messages.
    pub fn remaining(&self) -> Vec<Step> {
        self.steps.iter().cloned().collect()
    }

    fn mismatch(&self, what: String) -> HalError {
        HalError::Protocol(format!("replay step {}: {what}", self.line + 1))
    }

    fn advance(&mut self) {
        self.steps.pop_front();
        self.line += 1;
    }

    /// Matches buffered writes against `Write` steps.
    fn settle_writes(&mut self) -> Result<()> {
        while !self.pending_write.is_empty() {
            let Some(Step::Write(expected)) = self.steps.front() else {
                let next = self.steps.front().cloned();
                return Err(self.mismatch(format!(
                    "adapter wrote {:?} but the recording expects {next:?}",
                    String::from_utf8_lossy(&self.pending_write)
                )));
            };
            let expected = expected.clone();
            if self.pending_write.starts_with(&expected) {
                self.pending_write.drain(..expected.len());
                self.advance();
            } else if expected.starts_with(&self.pending_write) {
                return Ok(()); // partial write; wait for the rest
            } else {
                return Err(self.mismatch(format!(
                    "adapter wrote {:?}, recording expects {:?}",
                    String::from_utf8_lossy(&self.pending_write),
                    String::from_utf8_lossy(&expected)
                )));
            }
        }
        Ok(())
    }

    fn expect_control(&mut self, step: Step) -> Result<()> {
        self.settle_writes()?;
        if !self.pending_write.is_empty() {
            return Err(self.mismatch("control step during an incomplete write".into()));
        }
        match self.steps.front() {
            Some(front) if *front == step => {
                self.advance();
                Ok(())
            }
            other => {
                Err(self.mismatch(format!("adapter did {step:?}, recording expects {other:?}")))
            }
        }
    }
}

#[async_trait]
impl SerialLink for ReplaySerial {
    async fn write_all(&mut self, bytes: &[u8]) -> Result<()> {
        self.pending_write.extend_from_slice(bytes);
        self.settle_writes()
    }

    async fn read(&mut self, buf: &mut [u8], timeout: Duration) -> Result<usize> {
        self.settle_writes()?;
        match self.steps.front_mut() {
            Some(Step::Read(data)) if !buf.is_empty() => {
                let n = data.len().min(buf.len());
                buf[..n].copy_from_slice(&data[..n]);
                data.drain(..n);
                if data.is_empty() {
                    self.advance();
                }
                Ok(n)
            }
            // The device would stay silent until the tester does something.
            _ => Err(HalError::Timeout(timeout)),
        }
    }

    async fn set_break(&mut self, on: bool) -> Result<()> {
        self.expect_control(Step::Break(on))
    }

    async fn set_baud(&mut self, baud: u32) -> Result<()> {
        self.expect_control(Step::Baud(baud))
    }

    async fn clear_input(&mut self) -> Result<()> {
        Ok(())
    }
}

fn unescape(text: &str) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            let mut buf = [0u8; 4];
            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            continue;
        }
        match chars.next() {
            Some('r') => out.push(b'\r'),
            Some('n') => out.push(b'\n'),
            Some('t') => out.push(b'\t'),
            Some('s') => out.push(b' '),
            Some('\\') => out.push(b'\\'),
            Some('x') => {
                let hex: String = chars.by_ref().take(2).collect();
                out.push(u8::from_str_radix(&hex, 16).map_err(|_| format!("bad \\x{hex}"))?);
            }
            other => {
                return Err(format!(
                    "unknown escape \\{}",
                    other.map_or(String::new(), String::from)
                ))
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replay_checks_writes_and_feeds_reads() {
        let mut link = ReplaySerial::from_script(
            "# demo\n> ATZ\\r\n< ELM327 v1.4b\\r\\r>\n! break on\n>x 81 12\n<x C1 EF\n",
        )
        .unwrap();
        link.write_all(b"AT").await.unwrap();
        link.write_all(b"Z\r").await.unwrap();
        let mut buf = [0u8; 64];
        let n = link
            .read(&mut buf, Duration::from_millis(10))
            .await
            .unwrap();
        assert_eq!(&buf[..n], b"ELM327 v1.4b\r\r>");
        assert!(matches!(
            link.read(&mut buf, Duration::from_millis(10)).await,
            Err(HalError::Timeout(_))
        ));
        link.set_break(true).await.unwrap();
        link.write_all(&[0x81, 0x12]).await.unwrap();
        let n = link
            .read(&mut buf[..1], Duration::from_millis(10))
            .await
            .unwrap();
        assert_eq!(&buf[..n], &[0xC1]);
        let n = link
            .read(&mut buf, Duration::from_millis(10))
            .await
            .unwrap();
        assert_eq!(&buf[..n], &[0xEF]);
        assert!(link.is_finished());
    }

    #[tokio::test]
    async fn replay_rejects_wrong_bytes() {
        let mut link = ReplaySerial::from_script("> ATZ\\r\n").unwrap();
        assert!(link.write_all(b"ATI\r").await.is_err());
        let mut link = ReplaySerial::from_script("> ATZ\\r\n").unwrap();
        assert!(link.set_break(true).await.is_err());
    }

    #[test]
    fn script_errors_name_the_line() {
        let err = ReplaySerial::from_script("> ok\n? nope\n")
            .unwrap_err()
            .to_string();
        assert!(err.contains("line 2"), "{err}");
    }
}
