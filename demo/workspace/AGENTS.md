<!-- Demo content: a fictional developer's workspace for the Agentic HQ public demo. Not instructions for agents working on the kit itself. -->
# AGENTS.md

Start here. This file routes every agent (Claude Code, Codex, Copilot, OpenCode) to the right folder, skill and lesson. Keep it short; the details live in the linked files.

## Who you work for

An independent developer who ships five small projects and runs several coding agents side by side. Collaborators go by first name: Sam (sync engine), Priya (design), Jordan (paper-lantern docs), Mei (beta tester, tidepool field work) and Theo (CI and releases). Who does what: [memory/collaborators.md](memory/collaborators.md).

## Workspace map

| Folder | What lives there |
|---|---|
| [projects/orbit-notes](projects/orbit-notes/README.md) | Local-first notes app: TypeScript, React, sync engine, desktop and web |
| [projects/tidepool](projects/tidepool/README.md) | Coastal weather sensor pipeline: Python, DuckDB, a small dashboard |
| [projects/paper-lantern](projects/paper-lantern/README.md) | Static site generator and blog engine |
| [projects/fieldkit](projects/fieldkit/README.md) | The `fk` command-line utilities |
| [projects/agent-playbook](projects/agent-playbook/README.md) | Notes and patterns for working with coding agents |
| [notes](notes/now.md) | Meetings, ideas, drafts, the reading list and a daily journal |
| [memory](memory/MEMORY.md) | Lessons and facts that outlive a session |
| skills/ | One folder per skill, typed as `/name` |
| [ops](ops/README.md) | Runbooks, backups, CI notes and the local companions |

## Rules

1. **Drafts, never sends.** Mail, chat and release posts stay drafts until a person sends them. Why: [memory/lessons/inbox.md](memory/lessons/inbox.md).
2. **One git worktree per parallel worker.** Two agents in one checkout overwrite each other. See [memory/lessons/agents-parallel.md](memory/lessons/agents-parallel.md).
3. **Run the migration dry-run before touching the sync schema.** See [memory/lessons/sync-engine.md](memory/lessons/sync-engine.md).
4. **CI pins Node 22, the same as local.** See [memory/lessons/ci.md](memory/lessons/ci.md).
5. **Check the lockfile diff before merging a dependency bump.** See [memory/lessons/dependencies.md](memory/lessons/dependencies.md).
6. Times people read are 12-hour ("5:42 PM"). ISO stays in JSON and file names.
7. A finished HTML page goes on the HQ ring: `artifacts/<slug>.html` plus a `<slug>.json` sidecar.

## Lanes

Which agent takes which job, and what may leave this computer: [memory/agent-lanes.md](memory/agent-lanes.md). Short version: Claude Code for features and unknown bugs, Codex for reviews and test fixes in its own worktree, OpenCode for triage and first drafts, DeepSeek web for public questions only.

## Skills

| Skill | Use it for |
|---|---|
| [/release-notes](skills/release-notes/SKILL.md) | Release notes from merged PRs |
| [/triage](skills/triage/SKILL.md) | Inbox and issue triage, drafts only |
| [/pr-review](skills/pr-review/SKILL.md) | A second read of a pull request |
| [/dep-watch](skills/dep-watch/SKILL.md) | Dependency updates and advisories |
| [/weekly-review](skills/weekly-review/SKILL.md) | The week in HQ |
| [/test-fixer](skills/test-fixer/SKILL.md) | A failing or flaky test |
| [/design-critique](skills/design-critique/SKILL.md) | A UI screen or flow |
| [/standup](skills/standup/SKILL.md) | The daily standup draft |
| [/brain-refresh](skills/brain-refresh/SKILL.md) | Rebuild the Second Brain map |
| [/ship](skills/ship/SKILL.md) | Tag, build and publish a release |

When a skill hits friction, fix the problem, then add a line to its `## Gotchas`. The Monday skill review collects those lines.
