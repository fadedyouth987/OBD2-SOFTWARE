# Installing the edge daemon (Task 5.1)

Release archives and the MSI come from `.github/workflows/package.yml`, which also
installs each one on a clean runner and runs `scripts/smoke-installed-daemon.mjs`.

## Linux (systemd)

```bash
tar xzf edge-daemon-<version>-x86_64-unknown-linux-gnu.tar.gz
cd edge-daemon-<version>-x86_64-unknown-linux-gnu && sudo ./install.sh
sudo usermod -aG obd2-edge <technician>   # then log out and in
edge-daemon pair                          # as the technician
```

The service runs as the `obd2-edge` user (in `dialout` for serial adapters), keeps its
data in `/var/lib/obd2-edge` (readable by the service only), and trusts only the origin
in `/etc/obd2-edge/edge-daemon.env`. Members of the `obd2-edge` group may write only
`/var/lib/obd2-edge/pairing`, which is what `edge-daemon pair` needs.
`sudo ./uninstall.sh` removes it; `--purge` also deletes leases, codes and the audit log.

## Windows (MSI)

Install `edge-daemon-<version>-x86_64-pc-windows-msvc.msi`. It installs the
`RootCauseEdgeDaemon` service (its own account `NT SERVICE\RootCauseEdgeDaemon`, starts
with Windows, restarts after a failure), the 32-bit J2534 bridge, and data in
`C:\ProgramData\RootCauseOBD`, readable by the service and administrators only.
Add each technician to the local group "RootCause Technicians"
(`net localgroup "RootCause Technicians" <user> /add`); members can then run
`edge-daemon pair` in a new terminal.

Both listen on 127.0.0.1 and [::1] only, port 8765.
