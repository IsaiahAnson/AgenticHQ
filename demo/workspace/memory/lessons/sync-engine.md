# Lessons: sync engine

- **Run the migration dry-run before touching the sync schema.** The first schema v7 run flipped 41 pinned notes to regular notes; the dry-run summary would have shown every one. Take an `fk snap` first, read the diff summary, then run it for real. 2026-10-23 [ref: orbit-notes-migration-review]
- **Never trust the wall clock for ordering.** A laptop with a clock two hours behind kept losing edits; hybrid logical clocks fixed it. 2026-10-07 [ref: orbit-notes-sync-design]
- **Test merges with two devices, not one.** Single-device tests passed while tie-breaking was wrong. 2026-10-12 [ref: merge-test]

Related: [sync-protocol.md](../../projects/orbit-notes/docs/sync-protocol.md), [migration review](../../notes/meetings/2026-10-23-orbit-notes-migration-review.md).
