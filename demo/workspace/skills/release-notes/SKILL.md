---
name: release-notes
description: Draft release notes from merged pull requests since the last tag. Use when a release is coming up, on the Friday release-notes routine, or when asked "what changed since 0.8".
---

# /release-notes

## Steps
1. Find the last tag and list PRs merged since then.
2. Sort into **New**, **Improved**, **Fixed**, **Internal**. Internal stays out of the public notes.
3. Write one plain sentence per user-visible change. Name the benefit, not the code.
4. Fill [template.md](template.md) and save it as a draft next to the CHANGELOG.
5. Publish a ring page with the draft so it can be read on HQ.

## Rules
- A person edits before anything is published ([lesson](../../memory/lessons/releases.md)).
- Thank collaborators by first name.

## Gotchas
- 2026-10-30: PRs labeled `chore` still had user-visible fixes. Read the PR body, not just the label.
