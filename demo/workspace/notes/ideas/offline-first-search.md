# Idea: offline-first search for orbit-notes

Build the search index in a worker from the operation log instead of from the note table. Each device keeps its own index and updates it as operations arrive, so search works offline and stays current after sync.

- Tokenize per paragraph so long notes rank by the paragraph that matched.
- Store the index next to the note store; rebuild from scratch if the schema version changes.
- Testers asked for this: [beta-feedback.md](../../projects/orbit-notes/docs/beta-feedback.md).

Fits after schema v7 lands ([architecture](../../projects/orbit-notes/docs/architecture.md)).
