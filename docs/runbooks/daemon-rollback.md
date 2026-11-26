# Edge daemon rollback

Use when a daemon release breaks vehicle connections, pairing or safety checks in the field.

## Decide

- **Safety**: if a release could send a gated request it shouldn't, stop distribution first and roll back immediately. Every gated request still goes through `SafetyInterlock::check()` and fails closed, but don't wait to find out.
- **Version skew**: the web app shows an update banner when protocol majors differ (A-ENG-3). A rollback past a protocol major makes the current web app refuse the old daemon, so only roll back within the same protocol major, or deploy the matching web build too.

## Roll back

1. **Stop distribution**: pull the bad version from the download page and the update channel.
2. **Workshops reinstall the previous version**:
   - Windows: uninstall from Apps & features, run the previous `.msi`.
   - Linux: replace `/usr/local/bin/edge-daemon` with the previous release's binary, then `sudo systemctl restart obd2-edge-daemon` (unit in `apps/edge-daemon/packaging/linux/obd2-edge-daemon.service`).
   Data in the data directory (pairing, leases, audit log, ring buffer) is kept and stays compatible within a protocol major.
3. **Check**: `edge-daemon version` shows the previous version; the Devices page connects; `obd2_daemons_seen{version="<bad>"}` falls over the next day.
4. **Collect evidence**: ask an affected workshop for `edge-daemon diagnostics`. It writes a redacted support bundle (no VIN serials, tokens or keys) with logs and the last 100 audit rows.

## After

Add the failure to the HIL checklist if the bench didn't catch it, and record the incident.
