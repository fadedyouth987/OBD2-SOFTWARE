//! Fault injection for the virtual vehicles, on debug builds only.
//!
//! `EDGE_SIM_FAULTS` (comma separated) breaks a virtual vehicle the way a real
//! one breaks, so browser tests against the real daemon can reach fail-closed
//! paths (Task 4.1 gate: "unknown speed shows PRECONDITION_UNKNOWN"):
//!
//! - `no-road-speed`: no ECU answers OBD PID 0x0D, as when the speed source is
//!   dead.
//!
//! Release builds ignore the variable (`cfg!(debug_assertions)`), like
//! `EDGE_DEV_CLOUD_KEYS`, so a shipped daemon's vehicles can't be altered.

use super::profiles::Profile;

pub const ENV: &str = "EDGE_SIM_FAULTS";
const PID_SPEED: u8 = 0x0D;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Faults {
    pub no_road_speed: bool,
}

impl Faults {
    /// The faults in [`ENV`] on a debug build; none on a release build.
    pub fn from_env() -> Self {
        if !cfg!(debug_assertions) {
            return Self::default();
        }
        std::env::var(ENV)
            .map(|v| Self::parse(&v))
            .unwrap_or_default()
    }

    pub fn parse(raw: &str) -> Self {
        let mut f = Self::default();
        for name in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            match name {
                "no-road-speed" => f.no_road_speed = true,
                other => tracing::warn!("{ENV}: unknown fault {other:?} ignored"),
            }
        }
        if f != Self::default() {
            tracing::warn!(faults = ?f, "DEBUG BUILD: virtual vehicles run with injected faults");
        }
        f
    }

    /// The profile with these faults applied.
    pub fn apply(self, mut profile: Profile) -> Profile {
        if self.no_road_speed {
            for node in &mut profile.ecus {
                node.spec.obd_pids.retain(|&p| p != PID_SPEED);
            }
        }
        profile
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::profiles;

    #[test]
    fn no_road_speed_removes_pid_0d_and_nothing_else() {
        let reports_speed =
            |p: &Profile| p.ecus.iter().any(|n| n.spec.obd_pids.contains(&PID_SPEED));
        let p = profiles::by_id("ford-falcon-ba").unwrap();
        assert!(reports_speed(&p));
        let before: Vec<Vec<u8>> = p.ecus.iter().map(|n| n.spec.obd_pids.clone()).collect();
        let broken = Faults::parse("no-road-speed").apply(p);
        assert!(!reports_speed(&broken));
        for (n, was) in broken.ecus.iter().zip(before) {
            let mut want = was;
            want.retain(|&x| x != PID_SPEED);
            assert_eq!(n.spec.obd_pids, want);
        }
    }

    #[test]
    fn unknown_or_empty_faults_change_nothing() {
        assert_eq!(Faults::parse(""), Faults::default());
        assert_eq!(Faults::parse("bogus, ,"), Faults::default());
        assert_eq!(
            Faults::parse(" no-road-speed ,bogus"),
            Faults {
                no_road_speed: true
            }
        );
    }
}
