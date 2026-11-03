---
name: agent-lanes
description: Which agent takes which job, and what may leave this computer
---

# Agent lanes

- **Claude Code**: features, bugs with an unknown cause, multi-file refactors. Default lane.
- **Codex**: pull request reviews and test fixes, always in its own worktree.
- **Copilot**: inline edits in the editor.
- **Claude API**: jobs HQ runs on a schedule (radar sweep, weekly digest). HQ tracks every call.
- **DeepSeek web**: public questions only. Never paste private code or notes.
- **OpenCode** (free models): inbox triage, standup drafts, first passes on docs.

When a lane is near its usage window, HQ suggests the fallback from the lanes table in [agent-playbook](../projects/agent-playbook/docs/lanes.md).
