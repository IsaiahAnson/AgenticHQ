# Lessons: tidepool data

- **Flag readings, never delete them.** Storm spikes at st-02 looked like faults and were real; deleted rows could not be re-judged. 2026-10-09 [ref: tidepool-calibration]
- **Hash input files, not file names.** The gateway re-sent a file under a new name and it loaded twice. 2026-10-05 [ref: ingest]
- **Store times in UTC, show them local.** The dashboard was an hour off after the clocks changed. 2026-10-26 [ref: dashboard]

Pipeline: [pipeline.md](../../projects/tidepool/docs/pipeline.md).
