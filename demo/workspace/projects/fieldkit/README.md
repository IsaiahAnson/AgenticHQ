# fieldkit

`fk` is a pocket CLI for the chores around the other projects: syncing folders between machines, taking quick snapshots before risky changes and checking that a workstation is healthy.

| Command | What it does |
|---|---|
| `fk sync <from> <to>` | One-way folder sync with a dry-run preview |
| `fk snap [path]` | Timestamped snapshot of a folder, kept for 14 days |
| `fk doctor` | Checks Node, Python, git, disk space and the local companions |

Full reference: [docs/commands.md](docs/commands.md). The scope of `fk doctor` was settled in the [October scope meeting](../../notes/meetings/2026-10-21-fieldkit-doctor-scope.md). Plugin ideas: [notes/ideas/fk-plugins.md](../../notes/ideas/fk-plugins.md).

```
npm install -g ./
fk doctor
npm test
```
