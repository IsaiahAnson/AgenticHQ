---
name: dep-watch
description: Check every project for outdated packages and security advisories and rank what to bump first. Use on the daily dependency-watch routine or before a release.
---

# /dep-watch

## Steps
1. For each project, list outdated packages (npm, uv).
2. Mark each: **advisory**, **major**, **minor**, **patch**.
3. Rank: advisories first, then anything the build depends on, then the rest.
4. Publish a ring page with one row per package and a suggested PR grouping.
5. Open no PRs on its own; the bump goes through the [dependency bump playbook](../../projects/agent-playbook/playbooks/dependency-bump.md).

## Gotchas
- 2026-10-27: a minor Markdown parser release changed footnote output. Flag build-path packages even for minor bumps.
