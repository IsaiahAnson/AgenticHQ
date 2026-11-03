# orbit-notes

Local-first notes that sync between the desktop app and the web build. Every note is written to the local store first; the sync engine trades operations with the relay whenever it can reach it, so the app never waits on the network.

- Architecture: [docs/architecture.md](docs/architecture.md)
- Sync protocol: [docs/sync-protocol.md](docs/sync-protocol.md)
- Roadmap: [docs/roadmap.md](docs/roadmap.md)
- Beta feedback: [docs/beta-feedback.md](docs/beta-feedback.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)

## Run it

```
npm install
npm run dev        # web build on http://localhost:5173
npm run desktop    # desktop shell
npm test           # unit tests (vitest)
npm run e2e        # browser checks (playwright)
```

## Before you touch the sync schema

Run `npm run migrate -- --dry-run` against a copy of a real store first. The schema v7 review showed why: [notes/meetings/2026-10-23-orbit-notes-migration-review.md](../../notes/meetings/2026-10-23-orbit-notes-migration-review.md). The lesson lives in [memory/lessons/sync-engine.md](../../memory/lessons/sync-engine.md).
