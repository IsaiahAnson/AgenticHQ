---
name: test-fixer
description: Diagnose and fix a failing or flaky test in an isolated worktree. Use when CI is red, a test fails twice in a row, or an issue is labeled flaky.
---

# /test-fixer

## Steps
1. Create a worktree for the fix ([parallel workers](../../projects/agent-playbook/docs/parallel-workers.md)).
2. Reproduce: run the test alone 20 times, note the failure rate.
3. Suspect time, order and network first.
4. Fix the cause, not the assertion. Never raise a timeout to make it pass.
5. Prove it: 50 green runs in a row, then open a PR with the failure rate before and after.

## Gotchas
- 2026-10-15: re-running until green hid a real race. Quarantine after two failures and file an issue ([lesson](../../memory/lessons/ci.md)).
