# Idea: agent run replay

Record each agent session as a timeline: prompt, files read, commands run, files changed, result. Replay it in HQ next to the diff.

- Helps the Monday skill review: see where a skill caused friction.
- Pairs with the lanes table in [agent-playbook](../../projects/agent-playbook/docs/lanes.md).
- Raw material already exists in session logs; CASS can search them.

Related lessons: [agents-parallel.md](../../memory/lessons/agents-parallel.md).
