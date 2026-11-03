# Review checklist for agent-written code

Used by `/pr-review` ([skill](../../../skills/pr-review/SKILL.md)).

1. Does the change do what the issue asked, and nothing else?
2. Are new tests testing behavior, or just restating the code?
3. Any new dependency? Read the lockfile diff ([lesson](../../../memory/lessons/dependencies.md)).
4. Any file outside the stated scope touched?
5. Error paths: does anything fail silently?
6. Would a person understand the commit message in six months?

## What changed my mind
Agents rarely write broken code that fails tests. They write code that passes tests and quietly widens scope. Question 4 catches most of it.
