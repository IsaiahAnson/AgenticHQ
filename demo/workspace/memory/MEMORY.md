# Memory

One fact per file. Agents read this index at the start of a task; lessons live under `lessons/`.

## Facts
- [Agent lanes](agent-lanes.md) — which agent takes which job, and what may leave this computer
- [Collaborators](collaborators.md) — Sam, Priya, Jordan, Mei, Theo and what each owns
- [Preferences](preferences.md) — drafts not sends, 12-hour times, short reports
- [Workspace map](workspace-map.md) — where each kind of file lives
- [Release cadence](release-cadence.md) — Friday drafts, Tuesday ships, never on a Friday

## Lessons
- [Sync engine](lessons/sync-engine.md) — run the migration dry-run before touching the sync schema
- [CI](lessons/ci.md) — pin Node 22 in CI to match local; quarantine twice-failing tests
- [Parallel agents](lessons/agents-parallel.md) — give each parallel worker its own git worktree
- [Dependencies](lessons/dependencies.md) — check the lockfile diff before merging a dependency bump
- [Inbox](lessons/inbox.md) — triage writes drafts, never sends
- [Tidepool data](lessons/tidepool-data.md) — flag readings, never delete them
- [Releases](lessons/releases.md) — notes come from merged PRs, edited by a person
- [HQ operations](lessons/hq-operations.md) — refresh the map after moving folders
