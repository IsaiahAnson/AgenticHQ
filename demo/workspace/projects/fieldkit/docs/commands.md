# Commands

## fk sync

```
fk sync ./notes /mnt/laptop/notes --dry-run
fk sync ./notes /mnt/laptop/notes --delete
```

Copies new and changed files one way. `--dry-run` prints the plan; `--delete` also removes files that are gone from the source. Never deletes without `--delete`.

## fk snap

```
fk snap projects/orbit-notes
fk snap --list
fk snap --restore 2026-10-23T14-10
```

Writes a compressed snapshot to `~/.fieldkit/snaps/`. Snapshots older than 14 days are pruned on the next run. Take one before a schema migration (see [memory/lessons/sync-engine.md](../../../memory/lessons/sync-engine.md)).

## fk doctor

```
fk doctor
fk doctor --json
```

| Check | Passes when |
|---|---|
| node | Node 22.x, same as CI ([why](../../../memory/lessons/ci.md)) |
| python | 3.12 or newer |
| git | 2.45 or newer, `user.name` set |
| disk | 10 GB free on the workspace drive |
| companions | ntfy and Karakeep answer on their local ports |
