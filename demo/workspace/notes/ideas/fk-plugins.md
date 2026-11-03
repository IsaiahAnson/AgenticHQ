# Idea: fieldkit plugins

Let `fk doctor` load extra checks from `~/.fieldkit/checks/*.js`. Each file exports `{ name, run() }` and returns `{ ok, detail }`.

- Keep the core four checks built in.
- A plugin that throws counts as a failed check, never a crash.
- Not now: decided in the [doctor scope meeting](../meetings/2026-10-21-fieldkit-doctor-scope.md).

Current commands: [commands.md](../../projects/fieldkit/docs/commands.md).
