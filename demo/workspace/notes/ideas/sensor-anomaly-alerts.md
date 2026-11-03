# Idea: sensor anomaly alerts

When a tidepool box misses three reports in a row, or QC flags more than 10 percent of a station's readings in an hour, send a push through ntfy.

- Quiet hours from 10:00 PM to 7:00 AM unless water level is involved.
- One alert per station per incident; the follow-up says when it recovered.
- Runbook link in the alert: [sensor-box-offline.md](../../ops/runbooks/sensor-box-offline.md).

Came out of [calibration day](../meetings/2026-10-09-tidepool-calibration.md).
