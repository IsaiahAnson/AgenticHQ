# Architecture

orbit-notes has three layers. Each one can be tested without the others.

1. **Store** (`src/store/`): an IndexedDB-backed note store. Every write lands here first and is appended to the operation log.
2. **Sync engine** (`src/sync/`): reads the operation log, sends new operations to the relay, receives remote operations and merges them field by field. See [sync-protocol.md](sync-protocol.md).
3. **App shell** (`src/app/`): React views. They read from the store and never talk to the relay directly.

## Process model

- **Web:** the sync engine runs in a shared worker so two tabs never sync twice.
- **Desktop:** the same engine runs in the main process; the window talks to it over a small message channel.

## Why local-first

The app has to open instantly on a train with no signal. Notes are small, conflicts are rare, and when they happen the user should see both versions. The trade-offs were settled in [the October sync design meeting](../../../notes/meetings/2026-10-07-orbit-notes-sync-design.md).

## Open questions

- Full-text search on the web build is still a single index per device. Offline search ideas: [notes/ideas/offline-first-search.md](../../../notes/ideas/offline-first-search.md).
