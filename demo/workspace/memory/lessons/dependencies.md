# Lessons: dependencies

- **Check the lockfile diff before merging a dependency bump.** A one-line bump pulled in 37 new transitive packages, one of them a postinstall script. 2026-10-22 [ref: dependency-bump]
- **Bump packages that move together in one PR.** React without React DOM broke the web build for a day. 2026-09-29 [ref: orbit-notes-deps]
- **Read the changelog of anything that touches the build.** A Markdown parser minor release changed footnote output. 2026-10-27 [ref: paper-lantern-deps]

Playbook: [dependency bump](../../projects/agent-playbook/playbooks/dependency-bump.md).
