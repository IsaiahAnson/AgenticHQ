# WIRING.md - the skills deck, Apply all comments, email, stats and Micro Apps

Most widgets read small files in `snapshots/` that your agent writes. If a file is missing, the widget shows a quiet "not wired yet" note and nothing breaks. Stats is the exception: without `snapshots/stats.json`, it shows the live Agent HQ usage meters.

## The runner: skills deck cards and Apply all comments

Both run your agent headlessly through one command template in `os-config.json`:

```json
"runner": { "command": "", "cwd": "", "modelValues": [], "effortValues": [] }
```

In this local multi-agent setup, top-level `runner` is the default used by Apply all comments (which has no card agent). Deck cards select `runners.claude`, `runners.codex`, `runners.copilot`, or the opt-in `runners.claude-api` through their `agent` field. `runner` and `runners.claude` currently use the same Claude command. Keep them aligned unless Apply all comments is deliberately moved to another runner; removing `runner` would break that route.

- `command` is blank when shipped, so nothing runs until you set it. It takes one of three shapes:
  1. **Prompt on standard input (recommended).** The template is just your agent's headless command; the OS feeds it the prompt. Works for deck cards and Apply all comments.
  2. **`{prompt}` on the command line.** For an agent that only takes the prompt as an argument: `my-agent run "{prompt}"`. A deck card puts its prompt there (`/weekly-review`); Apply all comments puts one short line there that points at its prompt file.
  3. **`{skill}` (deck cards only, the v1 shape).** For an agent with no model or effort flags at all: `my-agent "/{skill}"`. `{skill}` is the card's id. Apply all comments cannot use this shape.
- If your agent is Claude Code, the template is:
  `claude -p --model {model} --effort {effort}`
  Add `--permission-mode bypassPermissions` only if you want runs to finish without stopping for permission prompts. That is a real trade-off: the run can then do anything your agent can do.
- `cwd`: the folder the run starts in, usually your main workspace (where your agent finds your skills).
- The model and effort dials are only labels. They reach your agent only if the template has `{model}` and `{effort}` in it: `{model}` gets the card's model name in lower case (`haiku`, `sonnet`, `opus`, `fable`), and `{effort}` the effort name (`low` to `max`). Rename the labels in `"models"` and `"efforts"` as you like. If your command wants different words, list them in `modelValues` / `effortValues` in the same order. If your agent has no such flags, leave both out of the template.

### Skills deck cards

Cards live in `os-config.json` under `"skills"`:

```json
"skills": [ { "id": "weekly-review", "icon": "pen", "model": 1, "effort": 1, "prompt": "/weekly-review" } ]
```

- `id`: lowercase letters, numbers and dashes. It shows as `/id`.
- `icon`: one of `bolt`, `trophy`, `broom`, `doc`, `gem`, `pen`, `send`, `eye`, `star`, `mail`, `cal`, `chart`.
- `model` / `effort`: positions in the dial lists (0 is the first).
- `prompt` (optional): what the run is told. Default: `/id`. A prompt must start with the skill's command, or the run may open the wrong skill.
- Restart the OS after editing. Press ▶ on a card: your agent runs, and the result lands on the ring as a formatted report.
- Good cards are skills that finish cleanly without asking you anything mid-run. Ask your agent to recommend 2 to 4. The + ADD SKILL button gives it a ready prompt.
- Each run uses your agent plan at the model the card is set to.

### Run-log retention for this local HQ

`os-runs/` holds a prompt and log for each deck attempt; `data/runs.json` is a separate generated summary. Review the folder monthly. Remove a successful run's `.log` and `.prompt.md` together after 30 days, and a failed run's pair after 90 days only when its investigation is closed. If the outcome is unclear or a report cites the log, keep the pair until reviewed. Do not use process exit 0 alone as proof of task success; read the result. Never edit `data/runs.json` to prune logs.

### Apply all comments

Review pages (any local page with the Apply all comments button) send their open comments to `POST /api/apply-comments` and poll `/api/run-status`. A quiet run edits the file, and the page shows the result and reloads. Those pages look for the OS on port 50000, the default. If HQ runs on another port, their button cannot reach it. Only pages on this computer can start it (the Security model in the README has the details).

## Email

The email widget sums up the last 24 hours of your inbox: a count, flagged rows that need you, and a mix bar (partnerships, leads, personal, other).

1. It calls a Gmail-capable command-line tool named in `"email"."command"`, using `gmail users messages list` and `get` with JSON params. If you use the Google Workspace CLI (`gws`), keep the shipped `"command": "gws"`; ask your agent to install it and sign in, with the Gmail API turned on in a Google Cloud project. If you use another Gmail CLI that takes the same commands, put its name there instead.
2. Set `"enabled": true` and restart the OS. The widget lights up on its next pull, and the TODAY'S MIX bar appears with your real counts (it stays hidden until then).
3. Tune the four buckets (partnerships, leads, personal, other) in `os-config.json`: `partnerHints` and `leadHints` are word lists matched against subjects, `personalFrom` matches the sender's domain. Flagged rows are partnerships and leads.

No Gmail CLI? Ask your agent to adapt `getEmail()` in `server.js` to the email access it has (it just returns rows), or remove the widget in edit mode.

## Stats

By default, the stats widget shows Agent HQ usage meters from `GET /api/stats`. Use `GET /api/stats?fresh=1` to bypass the OS cache when checking current usage. If `snapshots/stats.json` exists, its custom numbers replace the usage meters entirely, including for `fresh=1`. Create that file only when you intend to replace the usage widget. The custom format is:

```json
{ "title": "YOUTUBE", "big": 12345, "cap": "SUBSCRIBERS<br>1.2M lifetime views", "gridLabel": "3 UPLOADS THIS MONTH", "publishDays": [2, 9, 16], "link": "https://studio.youtube.com" }
```

- `title` renames the widget. `big` is the headline number. `cap` is the two-line label under it (`<br>` is the only HTML allowed).
- `publishDays` lights those days of the month in the dots grid; `gridLabel` is its caption. The grid stays hidden until `stats.json` exists, so an unwired widget shows no made-up dots.
- `link` (optional, http or https) makes the grid clickable.

**Recipe: YouTube.** Tell your agent: "Get my channel's subscriber count and this month's upload days from the YouTube Data API (a free key from the Google Cloud console, YouTube Data API v3). Write them to <path-to-your-os>/snapshots/stats.json in the WIRING.md format, and refresh it daily."

### Claude API organization usage and API credit

The **Claude API Org** row is separate from the Claude Max plan meter. With `ANTHROPIC_ADMIN_KEY` in the HQ server process environment, it reads the current calendar month's API usage cost from Anthropic's organization Cost Report every five minutes. This variable can hold an Admin API key or an organization-scoped personal or service-account key with access to the report. It must belong to the linked Console organization; a Default workspace key cannot read this report. Without that key, the row shows its setup requirement. Usage cost can be covered by credits; it is not the amount charged to your card. The report does not expose the live promotional-credit balance. Read the balance and expiry under Claude Console → Billing. Never put either key in `os-config.json`, a snapshot, or a repository file.

To use Max's included API credit for a new task, create a regular key scoped to the Default workspace in that same Console organization and make it available as `ANTHROPIC_API_KEY` to the process that calls the Messages API. The Skills Deck has an opt-in **/api-hq-review** card. When clicked, its `claude-api` runner sends only HQ health, companion readiness, and meter percentages to the Claude Messages API, then puts the result on the ring. It sends no live session titles. With no regular API key, it fails without making an API request. Keep the reporting credential separate from this task key. Restart HQ after adding either environment variable.

For a foreground restart without saving keys to a file or shell history, stop the current `node server.js` with Ctrl+C, then run `& .\tools\start-hq-with-claude-api.ps1` in PowerShell from the HQ folder. It prompts locally for the regular API key and optional Admin key, starts HQ, and removes both from that PowerShell process when HQ exits. The keys remain in the HQ server's process memory while it runs.

Before restarting HQ with a replacement reporting key, run `& .\tools\test-claude-report-key.ps1` from the HQ folder. It prompts locally and reports only whether the Cost Report accepted the key; it never prints or stores the key.

The HQ server strips both keys from ordinary deck runners. Only the opt-in `claude-api` runner receives the regular API key, and no runner receives the Admin key. This prevents existing Claude plan cards from silently switching to API billing.

If the organization Cost Report rejects the reporting key (for example with HTTP 403), the row shows only usage made by HQ's API card and the optional Claude effort classifier. That local fallback records call and token counts, not organization-wide spend or credit balance; other API clients are not included. Anthropic says the Admin API is unavailable for individual accounts, so an individual Console organization may have this limitation. Check Console Billing and Usage for the complete picture.

`tools/effort-optimizer.mjs --classifier claude` is another small API-credit use: it asks Sonnet to choose effort before launching a new Codex or Copilot CLI task. Its default `--classifier rules` uses no API credit. Example dry run:

```powershell
node tools/effort-optimizer.mjs --agent codex --mode suggest --classifier rules --dry-run --prompt 'Audit this contract for risks'
```

Remove `--dry-run` to launch a new CLI session with the chosen effort. Replace `codex` with `copilot` for Copilot. Use `--classifier claude` only when `ANTHROPIC_API_KEY` is configured and you intend the task prompt to go to the Claude API. This wrapper cannot change effort inside a chat that is already running.

### Agent task context packets

`GET /api/context?q=<task>` returns a read-only context packet. `POST /api/context` with JSON `{ "task": "...", "agent": "codex", "ai": false }` returns the same packet and logs the call in `data/context-usage.jsonl` without saving the task text. The packet contains source paths, line-numbered excerpts, modification times, SHA-256 hashes, canonical-source flags, and live checks. It retrieves from curated QMD notes, mapped Brain text contents, relevant HQ code, and Brain file names. The Brain's content index runs in memory, excludes secret-looking and generated files, and reports its coverage and limits. No model call is made by default.

Agents can use the CLI from the OS folder:

```powershell
node tools/hq-context.mjs "How does Agentic HQ run a Skills Deck card?" --agent=codex
```

Add `--json` for a machine-readable packet. Add `--ai` to make one opt-in Claude API synthesis call; only excerpts from the curated QMD knowledge and top-level HQ guides, plus the current HQ health flags, are sent. Arbitrary workspace files and HQ code stay local. The server holds `ANTHROPIC_API_KEY`, and the response's token usage is written to the local API usage ledger. The API answer is a lead, not a replacement for opening and verifying its cited source files. The endpoint is available after restarting HQ; the CLI calls the running server.

`config/context-authority.json` gives each HQ topic canonical files and live checks. Use these before treating older search hits as current fact. `node tools/hq-knowledge-audit.mjs` reports missing canonical files, notes without a recent `verified:` date, and exact duplicate note bodies; it changes nothing. `node tools/hq-context-eval.mjs` checks several representative tasks against the running endpoint. Re-run it after retrieval changes. A packet is preparation for an agent, not a claim that the task is complete.

### Automatic context for deck cards

A deck card can opt in with `"context": true`, or with `"context": { "task": "the retrieval task", "maxChars": 6000 }`. HQ builds a fresh packet with the same context library, adds recent warn/error events, and prepends the bounded packet to the card prompt; packet failures are logged but never stop the run. POST `/api/run` with `{ "id": "card-id", "dryRun": true }` returns the composed prompt without launching an agent, so configuration can be checked without usage.

### HQ event inbox

HQ stores metadata-only events in `os-runs/events.jsonl`, deduplicates keyed repeats, and rotates the file after 5 MB. `GET /api/events?since=&type=&severity=&limit=` lists newest first; local tools may POST `{ type, source, severity, key, summary, ref, data }` to `/local/event`, subject to the same localhost, token, origin, JSON, and size guards as other local mutations. Job results, engine restarts, companion state changes, usage thresholds, and scheduled Brain refreshes feed this inbox; prompts and secrets must never be included.

### Pull dashboard feeds

- `GET /api/since?since=<epoch-ms>&mailPrev=<count>` returns up to eight ranked, metadata-only changes for the homepage band. Missing event, outcome, artifact, radar, email, YouTube, or tracker data is treated as empty; email content is never returned.
- `GET /api/receipts` returns the weekly approval/run counts and measured follow-ups shown in What HQ Learned. The response is cached for 60 seconds.
- `GET /api/stats` keeps its existing fields and adds `forecast.meters`, computed from the last 14 days of `os-runs/usage-history.jsonl`. Each matching usage window gets a verdict, sentence, and sparkline values; missing history produces an empty meter list.

## Micro Apps

The tiles: your own apps, then Add more.

- **Your own apps** go in `os-config.json` under `"microApps"`:

```json
"microApps": [ { "id": "notes-app", "name": "My notes app", "desc": "One short line", "url": "http://localhost:3000/", "fallbackUrl": "", "icon": "gen" } ]
```

- `icon`: `gen`, `tele`, `brain`, `exca`, `recos` or `plus` (or draw a new 10x10 sprite in `ICS` in `os.html`).
- Restart the OS after editing. Each tile click is logged to `data/app-opens.jsonl`, which the Applications tab counts.
- The Add more tile gives your agent this same prompt, ready to copy.

## Keeping feeds fresh

Update custom `stats.json` only if you use custom stats. For schedule changes, follow [ROUTINES.md](ROUTINES.md): change the scheduler itself, then update `snapshots/routines.json` only for imported external routines.
