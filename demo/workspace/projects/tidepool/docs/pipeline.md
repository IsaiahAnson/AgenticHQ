# Pipeline

```
gateway inbox (CSV) -> ingest -> raw_readings -> qc -> clean_readings -> rollup -> daily_station
```

1. **ingest** (`tidepool/ingest.py`) reads every new CSV in the inbox, skips files it has seen (by content hash) and appends rows to `raw_readings`.
2. **qc** (`tidepool/qc.py`) flags out-of-range values, flat lines and spikes. Flags are kept, never deleted, so a bad sensor can be re-judged later.
3. **rollup** (`tidepool/rollup.py`) runs [sql/daily_rollup.sql](../sql/daily_rollup.sql) for each finished day.

Everything lives in one DuckDB file. A nightly copy goes to the backup folder; see [ops/backups/backup-plan.md](../../../ops/backups/backup-plan.md).

Lessons from running it: [memory/lessons/tidepool-data.md](../../../memory/lessons/tidepool-data.md).
