# Parallel workers

Two agents in one checkout will eventually write the same file. Give each worker its own git worktree and its own branch.

```
git worktree add ../orbit-notes-review -b review/schema-v7
git worktree add ../orbit-notes-tests  -b fix/flaky-merge-test
```

## Rules
1. One worktree per worker, named after the task.
2. The coordinator merges; workers never push to `main`.
3. Workers write a short hand-off note when done: what changed, what they ran, what is left.
4. Delete the worktree after the merge.

The incident that made this a rule is in [memory/lessons/agents-parallel.md](../../../memory/lessons/agents-parallel.md).

## What changed my mind
Running workers in parallel only helped once each one had a narrow brief and a separate folder. Before that, the merge took longer than the work.
