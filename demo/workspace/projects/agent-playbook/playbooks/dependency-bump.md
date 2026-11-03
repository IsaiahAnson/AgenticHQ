# Dependency bump

1. `/dep-watch` lists what is outdated and why it matters.
2. One bump per PR unless packages move together (React and React DOM).
3. Read the lockfile diff. New transitive packages get a second look ([lesson](../../../memory/lessons/dependencies.md)).
4. Run the full suite, then the e2e checks.
5. Note anything surprising in the PR description so the release notes can mention it.
