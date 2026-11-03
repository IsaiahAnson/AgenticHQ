# Flaky test triage

1. Re-run the failing test alone, 20 times. Note the failure rate.
2. If it fails twice in a row on main, quarantine it (`it.skip` with an issue link) and file an issue. See [memory/lessons/ci.md](../../../memory/lessons/ci.md).
3. Hand the issue to Codex with `/test-fixer` in its own worktree.
4. Look for time, order and network: fake timers, shared state between tests, real sockets.
5. Un-quarantine only after 50 green runs.
