#!/usr/bin/env bash
# Removes the edge daemon service (Task 5.1). Leases, pairing codes and the
# audit log in /var/lib/obd2-edge are kept unless --purge is given.
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 [--purge]" >&2
  exit 1
fi
systemctl disable --now obd2-edge-daemon.service 2>/dev/null || true
rm -f /etc/systemd/system/obd2-edge-daemon.service /usr/local/bin/edge-daemon \
  /etc/profile.d/obd2-edge.sh /etc/udev/rules.d/99-automotive-vci.rules
systemctl daemon-reload
udevadm control --reload-rules 2>/dev/null || true
if [ "${1:-}" = "--purge" ]; then
  rm -rf /var/lib/obd2-edge /etc/obd2-edge /usr/lib/sysusers.d/obd2-edge.conf
  userdel obd2-edge 2>/dev/null || true
  groupdel obd2-edge 2>/dev/null || true
fi
echo "edge-daemon removed."
