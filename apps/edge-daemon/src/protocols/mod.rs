//! Diagnostic transports and clients (Task 1.2).
//!
//! - Links move one diagnostic message (PDU) at a time: [`isotp::IsoTpLink`]
//!   (ISO 15765-2 over CAN, normal and BMW extended addressing),
//!   [`kline::KLineLink`] (ISO 14230-2 over a K-line adapter) and
//!   [`kline::ElmKLineLink`] (messages framed by an STN/ELM chip).
//! - [`DiagChannel`] wraps any link and is the only public way to send a
//!   request: it calls [`SafetyInterlock::check`] first, every time (A-ENG-4).
//!   It also handles NRC 0x78 (extend the wait to P2*), skips stale replies and
//!   reports each final answer back to the interlock.
//! - [`uds`], [`kwp2000`] and [`obd`] build requests and decode answers over
//!   any [`DiagTransport`].

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::time::Instant;

use crate::{
    hal::{serial::SerialLink, HalError, KLineAdapter, VehicleBusAdapter},
    protocol::messages::DiagProtocol,
    safety::interlock::{GatedRequest, Refusal, SafetyInterlock},
};

pub mod addressing;
pub mod isotp;
pub mod kline;
pub mod kwp2000;
pub mod obd;
pub mod uds;

/// Why a diagnostic request failed.
#[derive(Debug, thiserror::Error)]
pub enum DiagError {
    #[error(transparent)]
    Hal(#[from] HalError),
    /// Refused by the interlock before anything was sent.
    #[error(transparent)]
    Refused(#[from] Refusal),
    /// The ECU answered with a negative response.
    #[error("ECU refused service {sid:#04X}: NRC {nrc:#04X} {}", nrc_name(*nrc))]
    Negative { sid: u8, nrc: u8 },
    #[error("unexpected response: {0}")]
    Unexpected(String),
}

/// One request: protocol (for the safety policy), payload, optional safety token.
#[derive(Clone, Copy, Debug)]
pub struct DiagRequest<'a> {
    pub protocol: DiagProtocol,
    pub payload: &'a [u8],
    pub safety_token: Option<&'a str>,
}

/// Request bytes in, response bytes out (one diagnostic exchange). Returns the
/// ECU's final answer, positive or negative; refusals and transport failures
/// are errors. An empty response means a suppressed positive response.
#[async_trait]
pub trait DiagTransport: Send {
    async fn request(&mut self, req: DiagRequest<'_>) -> Result<Vec<u8>, DiagError>;
}

/// Application timing (ISO 14229-2 / ISO 14230-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// Time to the start of the ECU's response.
    pub p2: Duration,
    /// Extended wait after NRC 0x78 responsePending.
    pub p2_star: Duration,
    /// K-line: minimum gap between the ECU's response and the next request.
    pub p3_min: Duration,
    /// K-line: gap between request bytes (0 writes the message in one go).
    pub p4: Duration,
}

impl Timing {
    pub const CAN: Self = Self {
        p2: Duration::from_millis(50),
        p2_star: Duration::from_millis(5_000),
        p3_min: Duration::ZERO,
        p4: Duration::ZERO,
    };
    pub const KLINE: Self = Self {
        p2: Duration::from_millis(50),
        p2_star: Duration::from_millis(5_000),
        p3_min: Duration::from_millis(55),
        p4: Duration::ZERO,
    };
}

/// Names for common negative response codes.
pub fn nrc_name(code: u8) -> &'static str {
    match code {
        0x10 => "generalReject",
        0x11 => "serviceNotSupported",
        0x12 => "subFunctionNotSupported",
        0x13 => "incorrectMessageLengthOrInvalidFormat",
        0x14 => "responseTooLong",
        0x21 => "busyRepeatRequest",
        0x22 => "conditionsNotCorrect",
        0x24 => "requestSequenceError",
        0x31 => "requestOutOfRange",
        0x33 => "securityAccessDenied",
        0x35 => "invalidKey",
        0x36 => "exceedNumberOfAttempts",
        0x37 => "requiredTimeDelayNotExpired",
        0x72 => "generalProgrammingFailure",
        0x78 => "requestCorrectlyReceived-ResponsePending",
        0x7E => "subFunctionNotSupportedInActiveSession",
        0x7F => "serviceNotSupportedInActiveSession",
        _ => "unknown",
    }
}

/// Services whose sub-function byte carries the suppressPosRspMsgIndicationBit.
fn suppresses_positive(protocol: DiagProtocol, payload: &[u8]) -> bool {
    protocol == DiagProtocol::Uds
        && matches!(
            payload.first(),
            Some(0x10 | 0x11 | 0x28 | 0x31 | 0x3E | 0x85 | 0x87)
        )
        && payload.get(1).is_some_and(|sub| sub & 0x80 != 0)
}

/// A message-level link. Crate-private: outside code can only reach a link
/// through [`DiagChannel`], which always runs the interlock (A-ENG-4).
#[async_trait]
pub(crate) trait Link: Send {
    async fn send_pdu(&mut self, data: &[u8]) -> crate::hal::Result<()>;
    async fn recv_pdu(&mut self, timeout: Duration) -> crate::hal::Result<Vec<u8>>;
    /// (tx, rx) identifiers or addresses, for the safety token binding.
    fn ids(&self) -> (u32, u32);
    fn timing(&self) -> Timing;
}

/// A diagnostic connection to one ECU, gated by the session's interlock.
pub struct DiagChannel {
    link: Box<dyn Link>,
    interlock: Arc<SafetyInterlock>,
}

impl DiagChannel {
    pub fn isotp<A: VehicleBusAdapter + 'static>(
        link: isotp::IsoTpLink<A>,
        interlock: Arc<SafetyInterlock>,
    ) -> Self {
        Self {
            link: Box::new(link),
            interlock,
        }
    }

    pub fn kline<A: KLineAdapter + 'static>(
        link: kline::KLineLink<A>,
        interlock: Arc<SafetyInterlock>,
    ) -> Self {
        Self {
            link: Box::new(link),
            interlock,
        }
    }

    pub fn elm<L: SerialLink + 'static>(
        link: kline::ElmKLineLink<L>,
        interlock: Arc<SafetyInterlock>,
    ) -> Self {
        Self {
            link: Box::new(link),
            interlock,
        }
    }

    pub fn interlock(&self) -> &Arc<SafetyInterlock> {
        &self.interlock
    }

    /// (tx, rx) of the ECU this channel talks to.
    pub fn ids(&self) -> (u32, u32) {
        self.link.ids()
    }
}

#[async_trait]
impl DiagTransport for DiagChannel {
    async fn request(&mut self, req: DiagRequest<'_>) -> Result<Vec<u8>, DiagError> {
        let Some(&sid) = req.payload.first() else {
            return Err(DiagError::Unexpected("empty request".into()));
        };
        let (tx, rx) = self.link.ids();
        let gated = GatedRequest {
            protocol: req.protocol,
            tx,
            rx,
            payload: req.payload,
        };
        // A-ENG-4: the one check, before anything reaches the bus.
        self.interlock.check(&gated, req.safety_token)?;
        self.link.send_pdu(req.payload).await?;

        let timing = self.link.timing();
        let suppress = suppresses_positive(req.protocol, req.payload);
        let mut wait = timing.p2;
        let mut deadline = Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                if suppress {
                    return Ok(Vec::new());
                }
                return Err(HalError::Timeout(wait).into());
            }
            let resp = match self.link.recv_pdu(left).await {
                Ok(resp) => resp,
                Err(HalError::Timeout(_)) => continue,
                Err(e) => return Err(e.into()),
            };
            match resp.as_slice() {
                [0x7F, rsid, 0x78, ..] if *rsid == sid => {
                    // responsePending: not a failure; wait up to P2* for the answer.
                    wait = timing.p2_star;
                    deadline = Instant::now() + wait;
                }
                [0x7F, rsid, ..] if *rsid == sid => {
                    self.interlock.observe_response(&gated, &resp);
                    return Ok(resp);
                }
                [first, ..] if *first == sid.wrapping_add(0x40) => {
                    self.interlock.observe_response(&gated, &resp);
                    return Ok(resp);
                }
                _ => tracing::debug!("ignoring unrelated response {resp:02X?} to {sid:#04X}"),
            }
        }
    }
}

/// Sends a request and requires a positive response with at least `min_len` bytes.
pub async fn positive<T: DiagTransport + ?Sized>(
    t: &mut T,
    protocol: DiagProtocol,
    payload: &[u8],
    token: Option<&str>,
    min_len: usize,
) -> Result<Vec<u8>, DiagError> {
    let sid = payload[0];
    let resp = t
        .request(DiagRequest {
            protocol,
            payload,
            safety_token: token,
        })
        .await?;
    match resp.as_slice() {
        [] => Ok(resp), // suppressed positive response
        [0x7F, _, nrc, ..] => Err(DiagError::Negative { sid, nrc: *nrc }),
        [first, ..] if *first == sid.wrapping_add(0x40) && resp.len() >= min_len => Ok(resp),
        _ => Err(DiagError::Unexpected(format!(
            "{resp:02X?} to service {sid:#04X}"
        ))),
    }
}
