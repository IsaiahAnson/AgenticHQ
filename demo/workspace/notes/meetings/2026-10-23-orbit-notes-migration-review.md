# orbit-notes schema v7 migration review

Friday, October 23, 1:00 PM. Sam, me, Codex (review lane).

## What happened
The first v7 migration ran against a real store copy and turned 41 pinned notes into regular notes. The dry-run would have shown it: the diff summary listed `pinned: true -> false` for every one.

## Decisions
- Migrations always ship with `--dry-run` and a summary diff.
- Take an `fk snap` before running a migration for real.
- Codex reviews migration PRs in its own worktree.

## Follow-ups
- Lesson recorded: [sync-engine.md](../../memory/lessons/sync-engine.md)
- Protocol table updated: [sync-protocol.md](../../projects/orbit-notes/docs/sync-protocol.md)
