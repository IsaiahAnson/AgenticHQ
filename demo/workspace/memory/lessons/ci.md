# Lessons: CI

- **Pin Node 22 in CI to match local.** paper-lantern CI ran a newer Node than every laptop and a test passed in CI but failed locally for a week. 2026-10-19 [ref: paper-lantern-ci]
- **Quarantine a test that fails twice in a row and file an issue.** Re-running until green hid a real race in the merge test for three days. 2026-10-15 [ref: flaky-test-triage]
- **Cache the package manager, not `node_modules`.** A stale cache served an old build of a native module. 2026-10-02 [ref: orbit-notes-ci]

Playbook: [flaky test triage](../../projects/agent-playbook/playbooks/flaky-test-triage.md). `fk doctor` checks the local Node version ([commands](../../projects/fieldkit/docs/commands.md)).
