//! CAN addressing for ISO 15765 (Task 1.2): normal 11/29-bit and BMW D-CAN
//! extended addressing (tester 0x6F1 with the target address as first byte;
//! ECU replies on 0x600 + address with the tester address 0xF1 first).

use crate::hal::{CanFilter, CAN_SFF_MAX};

pub const OBD_FUNCTIONAL: u32 = 0x7DF;
pub const BMW_TESTER_ID: u32 = 0x6F1;
pub const BMW_TESTER_ADDR: u8 = 0xF1;
pub const BMW_RESPONSE_BASE: u32 = 0x600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CanAddressing {
    /// ISO 15765-4 normal addressing.
    Normal { tx: u32, rx: u32, extended: bool },
    /// ISO 15765-4 functional OBD request (0x7DF) answered by one ECU on `rx`.
    Functional { rx: u32 },
    /// BMW D-CAN extended addressing to ECU address `ecu`.
    BmwExtended { ecu: u8 },
}

impl CanAddressing {
    /// 11-bit physical addressing, e.g. `normal(0x7E0, 0x7E8)`.
    pub fn normal(tx: u32, rx: u32) -> Self {
        Self::Normal {
            tx,
            rx,
            extended: false,
        }
    }

    /// Functional OBD request on 0x7DF, listening to one responder on `rx`
    /// (0x7E8..=0x7EF). Flow Control goes to that ECU's physical request id.
    pub fn obd_functional(rx: u32) -> Self {
        Self::Functional { rx }
    }

    pub fn tx_id(&self) -> u32 {
        match *self {
            Self::Normal { tx, .. } => tx,
            Self::Functional { .. } => OBD_FUNCTIONAL,
            Self::BmwExtended { .. } => BMW_TESTER_ID,
        }
    }

    /// Where the tester's Flow Control goes. For functional requests that is
    /// the responder's physical request id (ISO 15765-4: response id - 8).
    pub fn flow_control_id(&self) -> u32 {
        match *self {
            Self::Functional { rx } => rx - 8,
            _ => self.tx_id(),
        }
    }

    pub fn rx_id(&self) -> u32 {
        match *self {
            Self::Normal { rx, .. } | Self::Functional { rx } => rx,
            Self::BmwExtended { ecu } => BMW_RESPONSE_BASE + u32::from(ecu),
        }
    }

    pub fn is_extended(&self) -> bool {
        matches!(self, Self::Normal { extended: true, .. })
    }

    /// Address byte the tester puts first in every frame.
    pub fn tx_prefix(&self) -> Option<u8> {
        match *self {
            Self::BmwExtended { ecu } => Some(ecu),
            Self::Normal { .. } | Self::Functional { .. } => None,
        }
    }

    /// Address byte expected first in every ECU frame.
    pub fn rx_prefix(&self) -> Option<u8> {
        match self {
            Self::BmwExtended { .. } => Some(BMW_TESTER_ADDR),
            Self::Normal { .. } | Self::Functional { .. } => None,
        }
    }

    /// Acceptance filter for the ECU's responses.
    pub fn rx_filter(&self) -> CanFilter {
        CanFilter::exact(self.rx_id(), self.is_extended())
    }

    /// Identifiers for the safety-token binding. For BMW, the ECU address is
    /// part of tx so tokens cannot be replayed against another module.
    pub fn token_ids(&self) -> (u32, u32) {
        match *self {
            Self::BmwExtended { ecu } => ((BMW_TESTER_ID << 8) | u32::from(ecu), self.rx_id()),
            Self::Normal { tx, rx, .. } => (tx, rx),
            Self::Functional { rx } => (OBD_FUNCTIONAL, rx),
        }
    }
}

const _: () = assert!(BMW_RESPONSE_BASE + 0xFF <= CAN_SFF_MAX);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bmw_extended_ids() {
        let a = CanAddressing::BmwExtended { ecu: 0x12 };
        assert_eq!(
            (a.tx_id(), a.rx_id(), a.tx_prefix(), a.rx_prefix()),
            (0x6F1, 0x612, Some(0x12), Some(0xF1))
        );
        assert_ne!(
            a.token_ids(),
            CanAddressing::BmwExtended { ecu: 0x40 }.token_ids()
        );
        let f = CanAddressing::obd_functional(0x7E8);
        assert_eq!(
            (f.tx_id(), f.flow_control_id(), f.rx_id()),
            (0x7DF, 0x7E0, 0x7E8)
        );
        let n = CanAddressing::normal(0x7E0, 0x7E8);
        assert_eq!((n.tx_id(), n.rx_id(), n.tx_prefix()), (0x7E0, 0x7E8, None));
    }
}
