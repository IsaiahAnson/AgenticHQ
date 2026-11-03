---
name: ship
description: Tag, build and publish a release after the notes are approved. Use on release day or when asked to ship a version; never on a Friday.
---

# /ship

## Steps
1. Confirm CI is green on the release commit.
2. Bump the version and move the release notes into the CHANGELOG.
3. Tag `v<version>` and push the tag.
4. Build the release artifacts and publish.
5. Draft the announcement; a person sends it.
6. Remind Theo to watch CI for 24 hours.

## Rules
- Never on a Friday ([release cadence](../../memory/release-cadence.md)).
- Stop on any red check. Do not retry a failed publish without reading the log.

## Gotchas
- 2026-10-16: a tag pushed before CI finished pointed at a broken build. Wait for green, then tag.
