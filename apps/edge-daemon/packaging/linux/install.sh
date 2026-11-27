#!/usr/bin/env bash
# Installs the edge daemon as a system service (Task 5.1). Run from the
# extracted release archive: sudo ./install.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

install -m 0755 "$here/edge-daemon" /usr/local/bin/edge-daemon
install -D -m 0644 "$here/obd2-edge.sysusers.conf" /usr/lib/sysusers.d/obd2-edge.conf
systemd-sysusers /usr/lib/sysusers.d/obd2-edge.conf

install -d -m 0755 /etc/obd2-edge
# Keep a local edit of the allowed origins across upgrades.
if [ ! -f /etc/obd2-edge/edge-daemon.env ]; then
  install -m 0644 "$here/edge-daemon.env" /etc/obd2-edge/edge-daemon.env
fi
install -m 0644 "$here/obd2-edge.profile.sh" /etc/profile.d/obd2-edge.sh

# Service-only data folder; only pairing/ is shared with the obd2-edge group.
install -d -m 0710 -o obd2-edge -g obd2-edge /var/lib/obd2-edge
install -d -m 2770 -o obd2-edge -g obd2-edge /var/lib/obd2-edge/pairing
# An earlier package shared the whole folder: take the group's access back.
find /var/lib/obd2-edge -mindepth 1 -maxdepth 1 ! -name pairing -exec chmod -R go-rwx {} +
find /var/lib/obd2-edge -mindepth 1 -maxdepth 1 ! -name pairing -exec chown -R obd2-edge:obd2-edge {} +
rm -f /var/lib/obd2-edge/pairing.json /var/lib/obd2-edge/pairing.tmp

install -m 0644 "$here/99-automotive-vci.rules" /etc/udev/rules.d/99-automotive-vci.rules
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger --subsystem-match=tty 2>/dev/null || true

install -m 0644 "$here/obd2-edge-daemon.service" /etc/systemd/system/obd2-edge-daemon.service
systemctl daemon-reload
systemctl enable obd2-edge-daemon.service
systemctl restart obd2-edge-daemon.service

echo "edge-daemon is running as the obd2-edge-daemon service (loopback port 8765)."
echo "Let a technician pair a browser:  sudo usermod -aG obd2-edge <user>   (then log in again)"
echo "Then, as that user:               edge-daemon pair"
