# Sync protocol

## Operations

Every change is an operation: `{ id, noteId, field, value, hlc, device }`.

- `hlc` is a hybrid logical clock stamp: wall time in milliseconds, a counter, and the device id. It always moves forward, even when a laptop clock jumps back.
- `field` is one of `title`, `body`, `tags`, `pinned`, `deleted`.

## Merge rule

For each `(noteId, field)` the operation with the highest `hlc` wins. Ties break on device id. Body edits are merged as text blocks, so two people editing different paragraphs both keep their work. The merge lives in `src/sync/merge.ts` and is covered by `tests/merge.test.ts`.

## Rounds

1. Client sends the highest `hlc` it has seen from the relay.
2. Relay answers with every newer operation, up to 500 per page.
3. Client sends its own unsent operations.
4. Relay acknowledges; the client marks them sent.

## Schema versions

| Version | Change |
|---|---|
| v5 | `tags` became an array |
| v6 | `pinned` moved from a tag to a field |
| v7 (in review) | operation log split per note for faster compaction |

Schema changes go through a dry-run first. See [memory/lessons/sync-engine.md](../../../memory/lessons/sync-engine.md).
