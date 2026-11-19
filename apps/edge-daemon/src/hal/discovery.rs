//! Lists the adapters attached to this machine, for `AdapterListResponse` (Task 1.4).
//!
//! - Virtual vehicles: always listed, one per built-in profile.
//! - SocketCAN (Linux): interfaces under `/sys/class/net` with type 280 (ARPHRD_CAN).
//! - Serial ports: classified by USB vendor/product id where the OS reports it
//!   (without libudev, Linux may not, and the port is listed as STN/ELM, the
//!   most common case). Nothing is sent to a port during discovery.
//! - J2534 (Windows): listed by the 32-bit bridge process (see `j2534_win`).

use std::path::Path;

use crate::{protocol::messages::AdapterKind, sim::profiles};

/// One adapter the user can connect to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredAdapter {
    pub adapter_id: String,
    pub kind: AdapterKind,
    pub display_name: String,
    /// Device path, interface name or DLL; `None` for virtual vehicles.
    pub path: Option<String>,
}

/// Guesses the adapter family from USB ids and descriptor strings.
pub fn classify_usb(
    vid: u16,
    pid: u16,
    manufacturer: Option<&str>,
    product: Option<&str>,
) -> AdapterKind {
    let text = format!("{} {}", manufacturer.unwrap_or(""), product.unwrap_or("")).to_lowercase();
    match (vid, pid) {
        _ if text.contains("obdlink") || text.contains("scantool") || text.contains("elm327") => {
            AdapterKind::StnElm
        }
        (0x0483, 0x5740) => AdapterKind::Slcan, // Flipper Zero / STM32 virtual COM port
        (0xAD50, 0x60C4) => AdapterKind::Slcan, // CANable (slcan firmware)
        _ if text.contains("flipper") || text.contains("canable") || text.contains("slcan") => {
            AdapterKind::Slcan
        }
        (0x0403, _) => AdapterKind::KlineFtdi, // plain FTDI: K+DCAN cables
        _ => AdapterKind::StnElm,              // CH340/CP210x ELM327 clones and unknowns
    }
}

/// SocketCAN interface names under a `/sys/class/net`-style directory.
pub fn socketcan_interfaces(net_root: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(net_root) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| std::fs::read_to_string(e.path().join("type")).is_ok_and(|t| t.trim() == "280"))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

fn serial_adapters() -> Vec<DiscoveredAdapter> {
    let Ok(ports) = serialport::available_ports() else {
        return Vec::new();
    };
    ports
        .into_iter()
        .map(|port| {
            let (kind, label) = match &port.port_type {
                serialport::SerialPortType::UsbPort(usb) => (
                    classify_usb(
                        usb.vid,
                        usb.pid,
                        usb.manufacturer.as_deref(),
                        usb.product.as_deref(),
                    ),
                    usb.product
                        .clone()
                        .unwrap_or_else(|| format!("USB serial {:04X}:{:04X}", usb.vid, usb.pid)),
                ),
                _ => (AdapterKind::StnElm, "Serial port".to_owned()),
            };
            let base = Path::new(&port.port_name)
                .file_name()
                .map_or(port.port_name.clone(), |n| n.to_string_lossy().into_owned());
            DiscoveredAdapter {
                adapter_id: format!("serial-{base}"),
                kind,
                display_name: format!("{label} ({})", port.port_name),
                path: Some(port.port_name),
            }
        })
        .collect()
}

/// Every adapter currently available.
pub fn discover() -> Vec<DiscoveredAdapter> {
    let mut out: Vec<DiscoveredAdapter> = profiles::all()
        .into_iter()
        .map(|p| DiscoveredAdapter {
            adapter_id: format!("virtual-{}", p.id),
            kind: AdapterKind::Virtual,
            display_name: format!("Virtual: {}", p.name),
            path: None,
        })
        .collect();
    if cfg!(target_os = "linux") {
        out.extend(
            socketcan_interfaces(Path::new("/sys/class/net"))
                .into_iter()
                .map(|name| DiscoveredAdapter {
                    adapter_id: format!("socketcan-{name}"),
                    kind: AdapterKind::Socketcan,
                    display_name: format!("SocketCAN {name}"),
                    path: Some(name),
                }),
        );
    }
    out.extend(serial_adapters());
    #[cfg(windows)]
    out.extend(super::j2534_win::discover());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usb_classification() {
        assert_eq!(
            classify_usb(0x0403, 0x6015, Some("ScanTool.net"), Some("OBDLink EX")),
            AdapterKind::StnElm
        );
        assert_eq!(
            classify_usb(0x0483, 0x5740, None, Some("Flipper Zero")),
            AdapterKind::Slcan
        );
        assert_eq!(classify_usb(0xAD50, 0x60C4, None, None), AdapterKind::Slcan);
        assert_eq!(
            classify_usb(0x0403, 0x6001, Some("FTDI"), Some("FT232R USB UART")),
            AdapterKind::KlineFtdi
        );
        assert_eq!(
            classify_usb(0x1A86, 0x7523, None, None),
            AdapterKind::StnElm
        );
    }

    #[test]
    fn finds_socketcan_interfaces_by_type() {
        let root = std::env::temp_dir().join(format!("edge-daemon-net-{}", std::process::id()));
        for (name, ty) in [("can0", "280"), ("vcan0", "280\n"), ("eth0", "1")] {
            std::fs::create_dir_all(root.join(name)).unwrap();
            std::fs::write(root.join(name).join("type"), ty).unwrap();
        }
        assert_eq!(socketcan_interfaces(&root), vec!["can0", "vcan0"]);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(socketcan_interfaces(&root).is_empty());
    }

    #[test]
    fn virtual_vehicles_always_listed() {
        let found = discover();
        let virtuals: Vec<_> = found
            .iter()
            .filter(|a| a.kind == AdapterKind::Virtual)
            .collect();
        assert_eq!(virtuals.len(), profiles::all().len());
        assert!(virtuals
            .iter()
            .any(|a| a.adapter_id == "virtual-generic-uds"));
    }
}
