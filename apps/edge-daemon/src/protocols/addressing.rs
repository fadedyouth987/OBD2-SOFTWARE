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

    /// Functional OBD request on 0x7DF, listening to one responder.
    pub fn obd_functional(rx: u32) -> Self {
        Self::Normal {
            tx: OBD_FUNCTIONAL,
            rx,
            extended: false,
        }
    }

    pub fn tx_id(&self) -> u32 {
        match *self {
            Self::Normal { tx, .. } => tx,
            Self::BmwExtended { .. } => BMW_TESTER_ID,
        }
    }

    pub fn rx_id(&self) -> u32 {
        match *self {
            Self::Normal { rx, .. } => rx,
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
            Self::Normal { .. } => None,
        }
    }

    /// Address byte expected first in every ECU frame.
    pub fn rx_prefix(&self) -> Option<u8> {
        match self {
            Self::BmwExtended { .. } => Some(BMW_TESTER_ADDR),
            Self::Normal { .. } => None,
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
        let n = CanAddressing::normal(0x7E0, 0x7E8);
        assert_eq!((n.tx_id(), n.rx_id(), n.tx_prefix()), (0x7E0, 0x7E8, None));
    }
}
