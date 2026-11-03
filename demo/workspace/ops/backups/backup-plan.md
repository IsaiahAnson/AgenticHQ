# Backup plan

| What | How often | Kept |
|---|---|---|
| Whole workspace | Nightly, 11:00 PM | 30 nights |
| tidepool DuckDB file | Nightly, after the rollup | 90 nights |
| orbit-notes relay store | Every 6 hours | 14 days |
| Snapshots from `fk snap` | On demand | 14 days |

The nightly backup check reads the newest log in this folder and raises an alert if a backup is missing or smaller than the night before by more than 20 percent.

Restoring: [restore-from-backup.md](../runbooks/restore-from-backup.md).
