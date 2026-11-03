---
name: pr-review
description: Give a pull request a second read for scope creep, weak tests and risky dependencies. Use when a PR is ready for review, especially agent-written ones, or when asked to review a branch.
---

# /pr-review

## Steps
1. Read the issue the PR says it fixes, then the diff.
2. Walk [checklist.md](checklist.md).
3. Check out the branch in its own worktree and run the tests there.
4. Comment with: blocking issues, suggestions, and one thing done well.

## Rules
- Codex runs this lane by default ([agent lanes](../../memory/agent-lanes.md)).
- Never approve your own lane's PR.

## Gotchas
- 2026-10-22: a lockfile diff hid 37 new packages. Always open the lockfile, even when the PR says "one-line bump".
