# Lessons: parallel agents

- **Give each parallel worker its own git worktree.** Claude Code and Codex both edited `merge.ts` in one checkout; one worker's fix silently replaced the other's. 2026-10-17 [ref: parallel-workers]
- **The coordinator merges, workers never push to main.** Two workers pushing produced a broken main for an hour. 2026-10-20 [ref: parallel-workers]
- **Every worker ends with a hand-off note.** Without one, the merge step re-ran every test to learn what changed. 2026-10-26 [ref: agent-run-replay]

Guide: [parallel-workers.md](../../projects/agent-playbook/docs/parallel-workers.md).
