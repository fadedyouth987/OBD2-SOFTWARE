//! BMW E90 built 03/2007 on: DME, CAS, DSC on BMW D-CAN 500 kbit/s.
//! Tester 0x6F1 + target byte; ECU replies on 0x600 + address. KWP2000-style
//! services over ISO-TP with extended addressing. The DME also answers OBD on
//! 0x7DF/0x7E0 with normal addressing, as on the real car.

use super::{e90_pre2007, CanAddr, EcuNode, Link, Profile};

pub const ID: &str = "bmw-e90-dcan";

pub fn profile() -> Profile {
    let mut ecus = Vec::new();
    for (spec, addr) in e90_pre2007::ecus() {
        let mut can = vec![CanAddr::BmwExtended { ecu: addr }];
        if addr == e90_pre2007::DME {
            can.push(CanAddr::Normal {
                req: 0x7E0,
                resp: 0x7E8,
            });
            can.push(CanAddr::Functional { resp: 0x7E8 });
        }
        ecus.push(EcuNode {
            spec,
            can,
            kline: None,
        });
    }
    Profile {
        id: ID,
        name: "BMW E90 (built 03/2007 on, D-CAN)",
        link: Link::Can { bitrate: 500_000 },
        ecus,
        periodic: Vec::new(),
        vehicle: e90_pre2007::vehicle(),
        isotp_pad: 0xFF,
    }
}
