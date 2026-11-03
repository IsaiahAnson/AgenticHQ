# Runbook: tidepool sensor box offline

1. Check the gateway inbox: is the station missing, or every station?
2. Every station: the gateway is down. Check its power and network first.
3. One station: look at its last `battery_v`. Under 3.5 V means a battery swap.
4. Battery fine: the radio link. Ask Mei whether a field visit is due.
5. Mark the gap in the dashboard notes so the daily rollup is not read as a real drop.

Station list: [sensors.md](../../projects/tidepool/docs/sensors.md). Alert idea: [sensor anomaly alerts](../../notes/ideas/sensor-anomaly-alerts.md).
