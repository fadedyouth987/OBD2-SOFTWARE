//! K+DCAN cables in K-line mode: raw FTDI serial at 10,400 baud (Task 1.1).
//!
//! - Fast init (ISO 14230-2): line idle (W5 ≥ 300 ms), 25 ms low (break),
//!   25 ms high; the tester then sends StartCommunication with `write_bytes`.
//! - 5-baud init (ISO 9141-2 / ISO 14230-2): the address byte bit-banged at
//!   5 baud with the break signal (start bit, 8 data bits LSB first, stop bit),
//!   then sync 0x55, key bytes KB1 KB2, the tester sends !KB2 and the ECU
//!   answers !address.
//! - The cable echoes everything the tester sends; `write_bytes` reads the
//!   echo back and checks it, so a mismatch (collision, bad cable) is reported.
//!
//! D-CAN-mode use of these cables is out of scope.

use std::time::Duration;

use async_trait::async_trait;
use tokio::time::{sleep, Instant};

use super::{serial::SerialLink, HalError, KLineAdapter, KeyBytes, Result};

const W5_IDLE: Duration = Duration::from_millis(300);
const TINI: Duration = Duration::from_millis(25);
const FIVE_BAUD_BIT: Duration = Duration::from_millis(200);
/// W1 (≤ 300 ms) plus margin for the sync byte.
const SYNC_TIMEOUT: Duration = Duration::from_millis(400);
/// W2/W3 (≤ 20 ms each) plus margin.
const KEY_BYTE_TIMEOUT: Duration = Duration::from_millis(100);
/// W4: tester waits 25–50 ms before sending !KB2.
const W4: Duration = Duration::from_millis(30);
const ECHO_TIMEOUT: Duration = Duration::from_millis(100);

/// K-line adapter over an FTDI-based K+DCAN cable (or any serial link).
pub struct KLineFtdiAdapter<L: SerialLink> {
    link: L,
    open: bool,
}

impl<L: SerialLink> KLineFtdiAdapter<L> {
    pub fn new(link: L) -> Self {
        Self { link, open: false }
    }

    pub fn link(&self) -> &L {
        &self.link
    }

    fn require_open(&self) -> Result<()> {
        if self.open {
            Ok(())
        } else {
            Err(HalError::NotOpen)
        }
    }

    /// Reads exactly `n` bytes, each within `timeout` of the previous.
    async fn read_exact(&mut self, n: usize, timeout: Duration) -> Result<Vec<u8>> {
        let mut out = Vec::with_capacity(n);
        let mut buf = [0u8; 64];
        while out.len() < n {
            let want = (n - out.len()).min(buf.len());
            let got = self.link.read(&mut buf[..want], timeout).await?;
            out.extend_from_slice(&buf[..got]);
        }
        Ok(out)
    }

    /// Bit-bangs `addr` at 5 baud: break = logic 0, released = logic 1.
    async fn send_5baud(&mut self, addr: u8) -> Result<()> {
        let bits = std::iter::once(false) // start bit
            .chain((0..8).map(|i| addr >> i & 1 == 1))
            .chain(std::iter::once(true)); // stop bit
        for bit in bits {
            self.link.set_break(!bit).await?;
            sleep(FIVE_BAUD_BIT).await;
        }
        self.link.set_break(false).await
    }
}

#[async_trait]
impl<L: SerialLink> KLineAdapter for KLineFtdiAdapter<L> {
    async fn open(&mut self, baud: u32) -> Result<()> {
        self.link.set_baud(baud).await?;
        self.open = true;
        Ok(())
    }

    async fn wake_fast_init(&mut self) -> Result<()> {
        self.require_open()?;
        sleep(W5_IDLE).await;
        self.link.set_break(true).await?;
        sleep(TINI).await;
        self.link.set_break(false).await?;
        sleep(TINI).await;
        self.link.clear_input().await
    }

    async fn wake_5baud(&mut self, addr: u8) -> Result<KeyBytes> {
        self.require_open()?;
        sleep(W5_IDLE).await;
        self.send_5baud(addr).await?;
        self.link.clear_input().await?;
        let sync = self.read_exact(1, SYNC_TIMEOUT).await?;
        if sync[0] != 0x55 {
            return Err(HalError::Protocol(format!(
                "5-baud init: sync byte {:02X}, expected 55",
                sync[0]
            )));
        }
        let kb = self.read_exact(2, KEY_BYTE_TIMEOUT).await?;
        sleep(W4).await;
        self.write_bytes(&[!kb[1]]).await?;
        let inv = self.read_exact(1, KEY_BYTE_TIMEOUT).await?;
        if inv[0] != !addr {
            return Err(HalError::Protocol(format!(
                "5-baud init: ECU answered {:02X}, expected {:02X}",
                inv[0], !addr
            )));
        }
        Ok(KeyBytes {
            kb1: kb[0],
            kb2: kb[1],
        })
    }

    async fn write_bytes(&mut self, bytes: &[u8]) -> Result<()> {
        self.require_open()?;
        self.link.write_all(bytes).await?;
        let echo = self
            .read_exact(bytes.len(), ECHO_TIMEOUT)
            .await
            .map_err(|e| match e {
                HalError::Timeout(_) => {
                    HalError::Protocol("no K-line echo: check the cable and ignition".into())
                }
                other => other,
            })?;
        if echo != bytes {
            return Err(HalError::Protocol(format!(
                "K-line echo mismatch: sent {bytes:02X?}, read {echo:02X?}"
            )));
        }
        Ok(())
    }

    async fn read_bytes(&mut self, max: usize, timeout: Duration) -> Result<Vec<u8>> {
        self.require_open()?;
        let deadline = Instant::now() + timeout;
        let mut buf = vec![0u8; max.max(1)];
        let n = self
            .link
            .read(&mut buf, deadline.saturating_duration_since(Instant::now()))
            .await?;
        buf.truncate(n);
        Ok(buf)
    }

    async fn close(&mut self) -> Result<()> {
        self.open = false;
        self.link.set_break(false).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hal::serial::ReplaySerial;

    const T: Duration = Duration::from_millis(100);

    /// Recorded K+DCAN fast init + StartCommunication + identification, echo included.
    #[tokio::test(start_paused = true)]
    async fn recorded_fast_init_session() {
        let link =
            ReplaySerial::from_script(include_str!("../../fixtures/hal/kline_ftdi_fast_init.txt"))
                .unwrap();
        let mut k = KLineFtdiAdapter::new(link);
        k.open(10_400).await.unwrap();
        let t0 = Instant::now();
        k.wake_fast_init().await.unwrap();
        assert!(
            Instant::now() - t0 >= Duration::from_millis(350),
            "W5 + TiniL + TiniH"
        );
        k.write_bytes(&[0x81, 0x12, 0xF1, 0x81, 0x05])
            .await
            .unwrap();
        assert_eq!(
            k.read_bytes(16, T).await.unwrap(),
            vec![0x83, 0xF1, 0x12, 0xC1, 0xEF, 0x8F, 0xC5]
        );
        // An echo that differs from what was sent is reported.
        assert!(k
            .write_bytes(&[0x82, 0x12, 0xF1, 0x1A, 0x80, 0x1F])
            .await
            .is_err());
        assert!(
            k.link().is_finished(),
            "unused recording: {:?}",
            k.link().remaining()
        );
    }

    #[tokio::test(start_paused = true)]
    async fn five_baud_handshake() {
        // Address 0x33: start(0) then bits LSB first 1,1,0,0,1,1,0,0, stop(1).
        let mut script = String::from("! baud 10400\n");
        for low in [
            true, false, false, true, true, false, false, true, true, false,
        ] {
            script.push_str(if low { "! break on\n" } else { "! break off\n" });
        }
        script.push_str("! break off\n<x 55\n<x 08 08\n>x F7\n<x F7 CC\n");
        let mut k = KLineFtdiAdapter::new(ReplaySerial::from_script(&script).unwrap());
        k.open(10_400).await.unwrap();
        let t0 = Instant::now();
        assert_eq!(
            k.wake_5baud(0x33).await.unwrap(),
            KeyBytes {
                kb1: 0x08,
                kb2: 0x08
            }
        );
        assert!(
            Instant::now() - t0 >= Duration::from_secs(2),
            "10 bits at 5 baud"
        );
        assert!(k.link().is_finished(), "{:?}", k.link().remaining());
    }

    #[tokio::test(start_paused = true)]
    async fn five_baud_rejects_bad_sync() {
        // Address 0xFF: start bit low, eight 1 bits and the stop bit high, release; then a wrong sync byte.
        let mut script = String::from("! baud 10400\n! break on\n");
        script.push_str(&"! break off\n".repeat(10));
        script.push_str("<x 00\n");
        let mut k = KLineFtdiAdapter::new(ReplaySerial::from_script(&script).unwrap());
        k.open(10_400).await.unwrap();
        assert!(matches!(
            k.wake_5baud(0xFF).await,
            Err(HalError::Protocol(_))
        ));
    }
}
