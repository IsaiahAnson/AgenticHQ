# Lanes

A lane is one agent with one kind of job and one privacy boundary. HQ tracks each lane's usage window, and the router suggests a fallback when one is near its limit.

| Lane | Good at | Can see private code? | Fallback |
|---|---|---|---|
| Claude Code | Features, unknown bugs, refactors across files | Yes | Codex |
| Codex | Reviews, test fixes, long test runs in its own worktree | Yes | Claude Code |
| Copilot | Inline completions, small edits in the editor | Yes | Codex |
| Claude API | Scripted jobs HQ runs: radar sweep, digests | Only what the job sends | Claude Code |
| DeepSeek web | Public questions, second opinions on algorithms | No: public text only | OpenCode |
| OpenCode | Triage, first drafts, standup notes on free models | Yes, local | Claude Code |

The day-to-day version of this table lives in [memory/agent-lanes.md](../../../memory/agent-lanes.md).

## What changed my mind
Splitting work by kind of task worked better than splitting by project. One agent that only reviews gets very good at reviewing.
