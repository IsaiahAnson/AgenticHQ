# Release 0.9

Target: the week of November 9. Planned in the [release planning meeting](../../../notes/meetings/2026-10-28-release-planning-0-9.md).

## Checklist
- [x] dusk theme merged
- [x] JSON Feed output with tests
- [x] incremental build behind a flag, then on by default
- [ ] release notes drafted with `/release-notes` (draft is on the HQ ring)
- [ ] docs pass by Jordan
- [ ] tag and publish with `/ship`

## Risks
- Incremental build cache on network drives. Fallback: `--no-cache`.
- Two open reports about footnotes in nested lists; one fixed, one cannot be reproduced.

Release habits that held up: [memory/release-cadence.md](../../../memory/release-cadence.md).
