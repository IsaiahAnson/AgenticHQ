# ROUTINES.md - list everything that runs on a schedule

Routines show in three places: the homepage ROUTINES widget (today's fires, with a countdown to the next one), the Second Brain's Routines tab (a Monday to Sunday week with every fire), and the gold ring of the 3D and 2D maps.

They come from two kinds of source.

## 1. Your agent's own scheduler (read for you when a reader exists)

- **If your agent is Claude Code:** its scheduled tasks are read for you. The task list comes from `~/.claude/scheduled-tasks/` (each task's `SKILL.md` gives its description). The schedule comes from the desktop app's `scheduled-tasks.json` files, found up to three folders deep under `claude-code-sessions`: `%APPDATA%\Claude\claude-code-sessions` on Windows, `~/Library/Application Support/Claude/claude-code-sessions` on macOS, `~/.config/Claude/claude-code-sessions` on Linux. Nothing to set up.
- **To change a Claude desktop task:** use the desktop Scheduled UI or its `update_scheduled_task` tool. The files above are read as state; editing `snapshots/routines.json` does not change a desktop task.
- **To turn that reader off** (you are not on Claude Code, or you do not want those folders read): set `"readers": { "claudeCode": false }` in `os-config.json`. The default, `"auto"`, reads them only when they exist.
- **Any other agent:** write its routines into the routines file below. To teach the OS to read another scheduler by itself, add a reader in `refresh/sources/` that returns `{ key, label, routines: [...] }` and list it in `READERS` in `refresh/lib/sources.cjs`, with its own switch under `"readers"`.

## 2. The routines file: `snapshots/routines.json`

One import file for external schedulers (cron, Windows Task Scheduler, launchd, systemd timers, servers, cloud jobs, or other agents). Update it when those schedules change. It describes their state to the OS; it does not control the schedulers. `snapshots/routines.example.json` is a template, not a live schedule. Copy it to `snapshots/routines.json` only when you have real external routines to import.

```json
{
  "timezone": "",
  "sources": [
    { "key": "agent",  "label": "MY AGENT" },
    { "key": "server", "label": "HOME SERVER" }
  ],
  "routines": [
    { "id": "morning-digest", "name": "Morning digest", "source": "agent",  "cron": "0 7 * * *", "desc": "Sum up my inbox and calendar" },
    { "id": "backup-sweep",   "name": "Backup sweep",   "source": "server", "days": ["mon", "wed", "fri"], "times": ["18:30"], "desc": "Copy the workspace to backup" },
    { "id": "inbox-check",    "name": "Inbox check",    "source": "agent",  "cron": "0 9-17 * * 1-5", "desc": "Hourly through the work day" },
    { "id": "weekly-review",  "name": "Weekly review",  "source": "agent",  "status": "ondemand", "desc": "Runs when I ask" }
  ]
}
```

- `timezone`: an IANA name such as `Europe/London`. Blank means this computer's time zone.
- `sources`: any names, any number. The label shows beside each routine and on the widget's legend.
- Each routine needs a `name` and either a `cron` (5 fields: minute, hour, day of month, month, day of week) or `days` plus `times` (24-hour). A routine with neither is "on demand".
- `status`: `active` (the default when it has a schedule), `paused` or `ondemand`. Paused and on-demand routines are listed but not placed on the week.
- `id` keeps the same routine matched to its usage figures (USAGE.md). Use short lowercase words with dashes.

v1 rows still work, so a v1 `snapshots/routines.json` can be copied straight across:

```json
{ "t": "07:00", "d": "daily", "src": "agent", "n": "morning digest", "desc": "..." }
```

(`d` is `daily`, day names like `mon,thu`, or `dom:1` for a day of the month.)

## Costs and runs

The Routines tab shows each routine's runs, tokens and API $ for the last 7 days only when something measured them (USAGE.md). Otherwise it says "not measured". Nothing is estimated.

## Keeping it fresh

For Claude desktop tasks, change the task in the Scheduled UI or with `update_scheduled_task`; the reader then picks up the new state. For an external scheduler, change it at its source and update `<path-to-your-os>/snapshots/routines.json` to match. The homepage widget reads the import within a minute. The Routines tab reads it each time the page loads or you press the refresh icon, and the map picks it up on that refresh.

On a Windows setup with the schedule installed, Task Scheduler runs **Agentic HQ Second Brain Refresh** every three hours from midnight local time. `tools/refresh-second-brain-scheduled.ps1` calls the same local refresh endpoint as the Brain button, verifies the engine completed a fresh populated scan, runs the knowledge coverage audit, and appends a result to `os-runs/second-brain-scheduled.jsonl`. `tools/install-second-brain-schedule.ps1` installs or repairs the task. The external schedule is shown in `snapshots/routines.json`. This checks configured sources; adding a new source still requires updating its owning config or reader.

## No routines yet?

Then this is your nudge. A morning digest, an evening log, a weekly report: each is one sentence to your agent ("every day at 7am, do X"). Start with one. Visible routines survive.
