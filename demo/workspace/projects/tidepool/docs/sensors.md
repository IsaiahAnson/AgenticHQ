# Sensors and stations

| Station | Site | Sensors | Notes |
|---|---|---|---|
| st-01 | North jetty | temp, humidity, wind, pressure | Oldest box, solar panel replaced in August |
| st-02 | Harbor wall | temp, humidity, water level | Tide gauge reads high in storms; see QC rule `wl_spike` |
| st-03 | Dune path | temp, humidity, wind | |
| st-04 | Lighthouse | temp, humidity, wind, pressure | Recalibrated after the [October calibration day](../../../notes/meetings/2026-10-09-tidepool-calibration.md) |
| st-05 | Boat ramp | temp, water level | Battery box swapped in September |
| st-06 | Salt marsh | temp, humidity, water level | Newest box, firmware 2.3 |

Readings arrive every five minutes. Each row: `station, ts_utc, metric, value, battery_v`.

Mei does field visits on the first Saturday of each month and logs them in the meeting notes.
