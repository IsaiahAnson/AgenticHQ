# RING.md - make every build land on the ring

The ring around the orb is the OS's memory of your work: every HTML page in the `artifacts/` folder becomes a ball you can reopen, search (`/`) and browse. The habit that makes it work: your agent registers everything it builds, by itself.

## The snippet (add it to your agent's instructions file)

Add this to the file your agent reads at the start of every session, with the one path changed:

```
### Put finished HTML on my OS ring
Every time you finish an HTML page for me (report, dashboard, one-pager, tool):
1. Copy the file to <path-to-your-os>/artifacts/<short-slug>.html
2. Write <short-slug>.json next to it:
   { "title": "Short Human Title", "icon": "doc", "kind": "report",
     "created": "<ISO timestamp>", "note": "one line on what it is",
     "svg": "<circle cx='24' cy='24' r='14'/>" }
3. The svg is 1 to 4 plain shapes (path, circle, rect, line, polyline, polygon, ellipse)
   on a 48x48 grid, with no fill or stroke attributes, and it should show THAT page
   so I can find it at a glance.
4. Tell me: "added to the OS ring as <title>".
Icon fallback categories: dash, deck, report, mail, video, chart, visual, bolt, doc.
Write clock times on the page in 12-hour form ("5:42 PM", never "17:42"). Keep ISO in JSON and file names.
```

During install, your agent can add this for you. Say yes when it offers.

## Notes

- The ring reads the folder live. A new file is a new ball on the next pull (within 2 minutes), no restart.
- **Right-click any ball** for OPEN (new tab) or REMOVE. Remove can be undone: the page and its sidecar move to `artifacts/_trash`. Drag them back out to restore the ball.
- The circle shows only as many balls as fit. Older ones hide by themselves; press `/` and matching hidden balls come up on an inner ring while you search.
- Every ball carries a grey 30-day arc that empties as it ages, and a day tag (none on the day it was made). The newest sits beside the orange index ball; hover the orange ball to see every name.
- The folder is `"artifactsDir"` in `os-config.json`. Point it anywhere (an absolute path works) to make the ring watch an existing folder.
- Skills deck runs register their own report balls.
- **Review bar:** every ring page opened from HQ gets a Review pill (bottom right, `assets/artifact-review.js`, injected by `server.js`). Highlight text to comment, then **Apply all** sends the comments to `/api/apply-comments`, which edits that page's file headlessly. **Save format…** sends the page to `/api/save-format`: a headless run drafts a skill in `data/skill-drafts/<name>/` (SKILL.md plus `assets/template.html`), and HQ installs it to `~/.claude/skills/<name>` (never over an existing skill). Pages with their own apply-comments UI, or `<meta name="rubric-review" content="off">`, are left alone.
- **Ring pages are sandboxed:** everything under `/artifacts/` is served with `Content-Security-Policy: sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads` (no `allow-same-origin`). A page runs its own scripts but has an opaque origin: it cannot call or read `/api/*` or `/local/*`, and it has no `localStorage` (comments wait in memory until applied). So write pages that stand alone, with their data inlined. Apply all and Save format open `assets/review-confirm.html`, an HQ window that shows the request and runs it only after you press **Run**; it accepts requests only from a bar carrying this run's ring nonce (`/api/ring-nonce`). Allow pop-ups for localhost if the window doesn't open.
- **Time Map** (`artifacts/time-map.html`, from `tools/time-map.mjs`, deck card `/time-map`): hours by task type, project, agent and week from redacted session digests, plus skills worth building. Task types live in `config/time-map.json`. **Micro-app finder** (deck card `/microapp-finder`) reads it and ranks the next Micro Apps tiles in `artifacts/microapp-finder.html`.
- A sidecar's `svg` only keeps plain shapes with plain geometry. Anything else (scripts, links, styles) drops the glyph, and the ball falls back to its category icon.
- Three sample balls ship with the kit. Delete their files in `artifacts/` any time.

## Report retention for this local HQ

Timestamped reports use `<family>-YYYYMMDD[-HHMM].html` (or an ISO-style date) with an optional same-name JSON sidecar. The weekly `tools/artifact-retention.mjs` run keeps the newest stamped page in each family active, moves older page/sidecar pairs into `artifacts/_trash/`, and permanently removes stamped trash pairs after 30 days. Pages without a trailing family stamp are canonical ring pages and the retention tool never touches them. Run with `--dry-run` to review the exact plan first.

Keep failed or cited reports, hand-made pages, guides, and chosen milestones as unstamped canonical pages when they must remain visible. A process exit of 0 can still contain a task failure, so promote a report before the weekly retention run if it is a milestone worth keeping.
