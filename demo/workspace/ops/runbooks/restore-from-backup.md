# Runbook: restore from backup

1. Stop whatever writes to the folder (dev server, sync engine, tidepool ingest).
2. Take an `fk snap` of the current state, even if it is broken.
3. Pick the newest backup from the nightly list ([backup plan](../backups/backup-plan.md)).
4. Restore into a new folder, not over the old one.
5. Diff old and restored; copy back only what is missing.
6. Start things again and run the project's tests.
7. Write down what happened in a lesson file if it taught something.
