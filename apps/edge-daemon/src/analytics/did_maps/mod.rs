//! Per-vehicle identifiers for the cross-module audit (Task 1.3): where each
//! module keeps its VIN and odometer, and where live vehicle speed comes from
//! (A-ENG-2). A vehicle without a map gets an INFO "not supported", never a pass.

use crate::{
    protocol::messages::DiagProtocol,
    protocols::addressing::CanAddressing,
    sim::{profiles, DID_ODOMETER, DID_VIN},
};

/// How a module is reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModuleAddr {
    Can(CanAddressing),
    KLine(u8),
}

/// One identifier read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdRead {
    /// UDS 0x22 or KWP2000 0x22 (common identifier).
    ReadDid(u16),
}

/// What one module can tell the audit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModuleMap {
    pub name: &'static str,
    pub protocol: DiagProtocol,
    pub addr: ModuleAddr,
    /// Answers OBD mode 0x01 (so it can supply vehicle speed, PID 0x0D).
    pub obd: bool,
    pub vin: Option<IdRead>,
    /// Odometer in km, 3 bytes big-endian.
    pub odometer: Option<IdRead>,
}

/// Where the interlock's vehicle-speed reading comes from (A-ENG-2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeedSource {
    /// CAN: PID 0x0D from any OBD module, alongside any other session.
    Obd,
    /// K-line: one ECU session at a time. Speed comes from the target module
    /// if it answers PID 0x0D; otherwise only by re-initializing to the DME,
    /// which ends the target session.
    KLineTargetOrDme { dme: u8 },
}

/// How to get a fresh speed reading while working on one module.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpeedPlan {
    /// Read PID 0x0D over an OBD channel to `module`.
    Obd { module: &'static str },
    /// Read PID 0x0D from the target module itself.
    FromTarget,
    /// No reading without giving up the current session; gated requests are
    /// refused with PRECONDITION_UNKNOWN (Rule 5).
    Unavailable { reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DidMap {
    pub profile_id: &'static str,
    pub modules: Vec<ModuleMap>,
    pub speed: SpeedSource,
}

impl DidMap {
    pub fn module(&self, name: &str) -> Option<&ModuleMap> {
        self.modules.iter().find(|m| m.name == name)
    }

    /// Speed plan while a session with `target` is open.
    pub fn speed_plan(&self, target: &str) -> SpeedPlan {
        match self.speed {
            SpeedSource::Obd => match self.modules.iter().find(|m| m.obd) {
                Some(m) => SpeedPlan::Obd { module: m.name },
                None => SpeedPlan::Unavailable { reason: "no OBD module in this vehicle map".into() },
            },
            SpeedSource::KLineTargetOrDme { dme } => match self.module(target) {
                Some(m) if m.obd => SpeedPlan::FromTarget,
                Some(_) => SpeedPlan::Unavailable {
                    reason: format!(
                        "K-line holds one session; {target} has no speed, and reading it from the DME ({dme:#04X}) means re-initializing and losing the {target} session"
                    ),
                },
                None => SpeedPlan::Unavailable { reason: format!("unknown module {target}") },
            },
        }
    }
}

fn bmw_modules(addr: impl Fn(u8) -> ModuleAddr) -> Vec<ModuleMap> {
    use profiles::e90_pre2007::{CAS, DME, DSC};
    let m = |name, a, obd, odo: bool| ModuleMap {
        name,
        protocol: DiagProtocol::Kwp2000,
        addr: addr(a),
        obd,
        vin: Some(IdRead::ReadDid(DID_VIN)),
        odometer: odo.then_some(IdRead::ReadDid(DID_ODOMETER)),
    };
    vec![
        m("DME", DME, true, true),
        m("CAS", CAS, false, true),
        m("DSC", DSC, false, false),
    ]
}

/// The map for a built-in profile, if the vehicle is supported.
pub fn for_profile(profile_id: &str) -> Option<DidMap> {
    let uds = |name, (req, resp): (u32, u32), obd, odo: bool| ModuleMap {
        name,
        protocol: DiagProtocol::Uds,
        addr: ModuleAddr::Can(CanAddressing::normal(req, resp)),
        obd,
        vin: Some(IdRead::ReadDid(DID_VIN)),
        odometer: odo.then_some(IdRead::ReadDid(DID_ODOMETER)),
    };
    Some(match profile_id {
        profiles::generic_uds::ID => DidMap {
            profile_id: profiles::generic_uds::ID,
            modules: vec![uds(
                "ENGINE",
                (
                    profiles::generic_uds::ENGINE_REQ,
                    profiles::generic_uds::ENGINE_RESP,
                ),
                true,
                true,
            )],
            speed: SpeedSource::Obd,
        },
        profiles::falcon_ba::ID => DidMap {
            profile_id: profiles::falcon_ba::ID,
            modules: vec![
                uds("PCM", profiles::falcon_ba::PCM, true, true),
                uds("IC", profiles::falcon_ba::IC, false, true),
                uds("ABS", profiles::falcon_ba::ABS, false, false),
            ],
            speed: SpeedSource::Obd,
        },
        profiles::e90_dcan::ID => DidMap {
            profile_id: profiles::e90_dcan::ID,
            modules: bmw_modules(|a| ModuleAddr::Can(CanAddressing::BmwExtended { ecu: a })),
            speed: SpeedSource::Obd,
        },
        profiles::e90_pre2007::ID => DidMap {
            profile_id: profiles::e90_pre2007::ID,
            modules: bmw_modules(ModuleAddr::KLine),
            speed: SpeedSource::KLineTargetOrDme {
                dme: profiles::e90_pre2007::DME,
            },
        },
        profiles::sandbox_immo::ID => DidMap {
            profile_id: profiles::sandbox_immo::ID,
            modules: vec![uds(
                "ENGINE",
                (
                    profiles::sandbox_immo::ENGINE_REQ,
                    profiles::sandbox_immo::ENGINE_RESP,
                ),
                true,
                true,
            )],
            speed: SpeedSource::Obd,
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_profile_has_a_map_and_a_speed_source() {
        for p in profiles::all() {
            let map = for_profile(p.id).unwrap_or_else(|| panic!("no map for {}", p.id));
            assert!(
                map.modules.iter().any(|m| m.obd),
                "{} has no speed module",
                p.id
            );
        }
        assert!(for_profile("holden-vt-1998").is_none());
    }

    #[test]
    fn kline_speed_plan_depends_on_target() {
        let map = for_profile(profiles::e90_pre2007::ID).unwrap();
        assert_eq!(map.speed_plan("DME"), SpeedPlan::FromTarget);
        assert!(matches!(
            map.speed_plan("DSC"),
            SpeedPlan::Unavailable { .. }
        ));
        let can = for_profile(profiles::falcon_ba::ID).unwrap();
        assert_eq!(can.speed_plan("ABS"), SpeedPlan::Obd { module: "PCM" });
    }
}
