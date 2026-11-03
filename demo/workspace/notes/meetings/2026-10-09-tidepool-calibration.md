# tidepool calibration day

Friday, October 9, 8:30 AM, on site. Mei, me.

## Findings
- st-04 temperature read 0.6 degrees high against the reference probe. Offset applied in firmware.
- st-02 tide gauge spikes in storms are real wave action, not a fault. QC rule `wl_spike` now looks at a 15-minute window.
- st-05 battery dropped to 3.4 V overnight. Box swapped.

## Follow-ups
- Re-run QC on st-04 for September with the new offset ([pipeline](../../projects/tidepool/docs/pipeline.md))
- Mei: field check on st-04 in early November
- Me: alert when a box misses three reports in a row ([idea](../ideas/sensor-anomaly-alerts.md))
