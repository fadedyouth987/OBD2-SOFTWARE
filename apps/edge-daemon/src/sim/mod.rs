//! Virtual vehicles (Task 1.1): simulated ECUs and the state they report, so
//! every upper layer can be tested without hardware.
//!
//! - [`ecu`]: application-layer ECU engine (UDS, KWP2000, OBD).
//! - [`isotp_peer`]: ECU side of ISO 15765-2, used by the virtual CAN bus.
//! - [`kline_peer`]: ISO 14230-2 framing, used by the virtual K-line.
//! - [`profiles`]: the four vehicles from the build plan.
//!
//! The ECU-side ISO-TP and K-line code here is deliberately separate from the
//! tester-side implementations in Task 1.2, so each checks the other.

pub mod ecu;
pub mod faults;
pub mod isotp_peer;
pub mod kline_peer;
pub mod profiles;

/// UDS / KWP common identifier for the VIN.
pub const DID_VIN: u16 = 0xF190;
/// Odometer in km, 3 bytes big-endian (simulator convention; real cars vary per make).
pub const DID_ODOMETER: u16 = 0xDD01;

/// Physical state of the simulated vehicle, shared by all its ECUs.
#[derive(Clone, Debug, PartialEq)]
pub struct VehicleState {
    pub vin: String,
    pub odometer_km: u32,
    pub speed_kmh: f64,
    pub rpm: f64,
    pub battery_v: f64,
    pub ect_c: f64,
    pub iat_c: f64,
    pub ambient_c: f64,
    /// Short- and long-term fuel trims, bank 1 and bank 2, in percent.
    pub stft_pct: [f64; 2],
    pub ltft_pct: [f64; 2],
    pub maf_gs: f64,
    pub throttle_pct: f64,
    pub load_pct: f64,
    pub runtime_s: u32,
    pub distance_since_clear_km: u32,
    pub monitors_complete: bool,
    /// Driver's window switch, broadcast on the bus (CAN RE fixtures, Task 1.3).
    pub window_switch: bool,
}

impl Default for VehicleState {
    /// Key on, engine off, parked, warm battery.
    fn default() -> Self {
        Self {
            vin: "1HGCM82633A004352".into(),
            odometer_km: 120_000,
            speed_kmh: 0.0,
            rpm: 0.0,
            battery_v: 12.6,
            ect_c: 20.0,
            iat_c: 20.0,
            ambient_c: 20.0,
            stft_pct: [0.0, 0.0],
            ltft_pct: [0.0, 0.0],
            maf_gs: 0.0,
            throttle_pct: 0.0,
            load_pct: 0.0,
            runtime_s: 0,
            distance_since_clear_km: 1_500,
            monitors_complete: true,
            window_switch: false,
        }
    }
}
