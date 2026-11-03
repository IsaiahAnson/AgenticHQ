# orbit-notes sync design

Wednesday, October 7, 10:00 AM. Sam, me.

## Decisions
- Replace wall-clock stamps with hybrid logical clocks. A laptop with a wrong clock was overwriting newer edits.
- Merge per field, not per note. Title and pinned state never conflict with body edits.
- Long bodies merge as paragraphs for now; a real text merge waits until after 0.15.

## Action items
- Sam: HLC implementation and tests
- Me: update [sync-protocol.md](../../projects/orbit-notes/docs/sync-protocol.md)
- Me: write the lesson about dry-runs before schema changes ([lesson file](../../memory/lessons/sync-engine.md))
