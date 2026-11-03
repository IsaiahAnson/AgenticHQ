#!/usr/bin/env node
/*
 * demo/workspace-gen.mjs
 *
 * Pads the Agentic HQ demo workspace with a couple of thousand small,
 * plausible project files (source, tests, assets, dated notes) so the Second
 * Brain map, timeline and search look like a real person's workspace.
 *
 *   node demo/workspace-gen.mjs <workspace dir>
 *
 * - Deterministic: one seeded RNG, fixed lists, a fixed anchor date.
 * - Idempotent: never overwrites a file. A second run creates nothing and
 *   only re-stamps edit times.
 * - Self-contained: Node built-ins only, no network.
 * - Safe: writes only inside <workspace dir>, and only when that folder is
 *   missing, empty, or holds the demo AGENTS.md.
 *
 * Edit times are set relative to the moment the script runs: the demo's
 * "today" (2026-11-02) maps to now, so a note dated October 30 always looks
 * three days old. Hand-written core files are re-stamped the same way.
 *
 * Every project, person and event in here is fictional.
 */

import fs from "node:fs";
import path from "node:path";

const SEED = 20261102;
const ANCHOR = Date.UTC(2026, 10, 2, 18, 0, 0); // the demo's "now": Monday, November 2, 2026
const DAY = 86400000;
const MARKER = "fictional developer's workspace for the Agentic HQ public demo";
const NOW = Date.now();
const started = process.hrtime.bigint();

// ---------- target folder and guard ----------
const arg = process.argv[2];
if (!arg) {
  console.error("usage: node demo/workspace-gen.mjs <workspace dir>");
  process.exit(2);
}
const ROOT = path.resolve(arg);
guard();

function fail(msg) {
  console.error("workspace-gen: " + msg);
  process.exit(1);
}

function guard() {
  if (!fs.existsSync(ROOT)) {
    fs.mkdirSync(ROOT, { recursive: true });
    return;
  }
  if (!fs.statSync(ROOT).isDirectory()) fail("not a folder: " + ROOT);
  if (fs.readdirSync(ROOT).length === 0) return;
  let agents = "";
  try {
    agents = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf8");
  } catch {
    // no AGENTS.md: refuse below
  }
  if (!agents.includes(MARKER)) fail("refusing to write into " + ROOT + ": not empty and not the demo workspace");
}

// ---------- seeded randomness ----------
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const num = (lo, hi) => lo + rnd() * (hi - lo);
const pick = (list) => list[Math.floor(rnd() * list.length)];
const chance = (p) => rnd() < p;
function pickN(list, n) {
  const pool = list.slice();
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return out;
}
function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[int(0, 15)];
  return s;
}
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------- dates and text helpers ----------
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");
const dayAt = (y, m, d) => Date.UTC(y, m - 1, d);
const ymd = (t) => {
  const d = new Date(t);
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
};
const longDate = (t) => {
  const d = new Date(t);
  return WEEKDAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
};
const shortDate = (t) => {
  const d = new Date(t);
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
};
const clock = (h, m) => (h % 12 || 12) + ":" + pad(m) + (h < 12 ? " AM" : " PM");
const ageAt = (t) => (ANCHOR - t) / DAY;
const isWeekend = (t) => {
  const w = new Date(t).getUTCDay();
  return w === 0 || w === 6;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const slugify = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-");
const spaced = (camel) => camel.replace(/([a-z])([A-Z])/g, (_, a, b) => a + " " + b).toLowerCase();
const camelOf = (kebab) => kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const titleOf = (rel) => path.posix.basename(rel).replace(/\.[a-z]+/i, "").replace(/-/g, " ");

// ---------- writing files ----------
const emitted = new Set();
const madeDirs = new Set();
let created = 0;
let kept = 0;

function inside(abs) {
  const r = path.relative(ROOT, abs);
  return Boolean(r) && !r.startsWith("..") && !path.isAbsolute(r);
}

function emit(rel, body, ageDays) {
  if (emitted.has(rel)) return;
  emitted.add(rel);
  const abs = path.join(ROOT, ...rel.split("/"));
  if (!inside(abs)) fail("path escapes the workspace: " + rel);
  const dir = path.dirname(abs);
  if (!madeDirs.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  }
  const when = new Date(NOW - Math.max(120000, ageDays * DAY));
  let fd;
  try {
    fd = fs.openSync(abs, "wx");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    fs.utimesSync(abs, when, when);
    kept++;
    return;
  }
  try {
    fs.writeSync(fd, body.endsWith("\n") ? body : body + "\n");
    fs.futimesSync(fd, when, when);
  } finally {
    fs.closeSync(fd);
  }
  created++;
}

const lines = (...parts) => parts.flat().join("\n");
const link = (from, to, text) => "[" + (text || titleOf(to)) + "](" + path.posix.relative(path.posix.dirname(from), to) + ")";
const wiki = (to) => "[[" + path.posix.basename(to).replace(/\.md/i, "") + "]]";
const ref = (from, to) => (chance(0.5) ? wiki(to) : link(from, to));

// ---------- shared world ----------
// Hand-written core files that generated notes link to.
const CORE = {
  orbit: [
    "projects/orbit-notes/docs/sync-protocol.md",
    "projects/orbit-notes/docs/architecture.md",
    "projects/orbit-notes/docs/roadmap.md",
    "projects/orbit-notes/docs/beta-feedback.md",
    "notes/meetings/2026-10-23-orbit-notes-migration-review.md",
    "notes/meetings/2026-10-30-design-review-sync-status.md",
    "memory/lessons/sync-engine.md",
  ],
  tide: [
    "projects/tidepool/docs/sensors.md",
    "projects/tidepool/docs/pipeline.md",
    "notes/meetings/2026-10-09-tidepool-calibration.md",
    "memory/lessons/tidepool-data.md",
    "ops/runbooks/sensor-box-offline.md",
  ],
  lantern: [
    "projects/paper-lantern/docs/themes.md",
    "projects/paper-lantern/docs/release-0.9.md",
    "notes/meetings/2026-10-14-paper-lantern-theme-review.md",
    "notes/meetings/2026-10-28-release-planning-0-9.md",
    "memory/lessons/releases.md",
  ],
  fk: [
    "projects/fieldkit/docs/commands.md",
    "notes/meetings/2026-10-21-fieldkit-doctor-scope.md",
    "memory/lessons/ci.md",
  ],
  agents: [
    "projects/agent-playbook/docs/lanes.md",
    "projects/agent-playbook/docs/parallel-workers.md",
    "projects/agent-playbook/docs/prompt-patterns.md",
    "memory/lessons/agents-parallel.md",
    "memory/agent-lanes.md",
    "memory/lessons/hq-operations.md",
  ],
  life: [
    "notes/now.md",
    "notes/reading-list.md",
    "memory/MEMORY.md",
    "ops/backups/backup-plan.md",
    "memory/lessons/inbox.md",
    "memory/lessons/dependencies.md",
  ],
};

const WORK = {
  orbit: [
    "worked through merge edge cases with two simulated devices",
    "cleaned up the sync status copy after the design review",
    "profiled compaction on a 20,000-operation log",
    "reviewed Sam's clock branch and left three comments",
    "chased the pinned-order bug down to the resync path",
    "wrote e2e checks for offline edits in two tabs",
    "tested the desktop tray menu on a light taskbar",
    "trimmed the web bundle by moving search into a worker",
    "ran the schema v7 dry-run against a copied store",
    "paired with Priya on the conflict banner wording",
  ],
  tide: [
    "re-ran QC for st-04 with the new temperature offset",
    "looked at storm readings from the harbor wall gauge",
    "added a gap report page to the dashboard",
    "checked battery trends across all six boxes",
    "wrote the weekly station report",
    "tightened the ingest hash check after a duplicate file",
    "compared wind at the jetty and the lighthouse",
    "moved two slow queries into views",
  ],
  lantern: [
    "polished the dusk theme sidebar at narrow widths",
    "fixed footnotes inside nested lists",
    "measured incremental build times on a 400-post site",
    "reviewed Jordan's docs pull request",
    "added JSON Feed tests for tags and summaries",
    "wrote a post draft about small tools",
    "tidied the theme partials so each theme has the same files",
  ],
  fk: [
    "added a disk space check to fk doctor",
    "made fk sync print a clearer plan in dry-run mode",
    "wrote a test for snapshot pruning",
    "gave fk doctor a JSON output for HQ",
    "fixed fk sync on folders with spaces in their names",
  ],
  agents: [
    "split a refactor across two worktrees and merged both",
    "had Codex review the migration pull request in its own worktree",
    "let OpenCode draft the standup notes; two small edits",
    "added a gotcha to a skill after a rough run",
    "ran the prompt evals for the triage prompt",
    "moved a long test run to the Codex lane",
    "updated the lanes table after a usage window ran out mid-task",
  ],
  life: [
    "took a long walk at lunch and sketched the talk outline on paper",
    "read the inbox triage drafts; sent two replies by hand",
    "had a quiet day, mostly reading",
    "checked a backup the nightly check flagged; it was fine",
    "cleared the reading list inbox",
    "kept it short: fixed one bug and stopped",
  ],
};
const AREAS = ["orbit", "tide", "lantern", "fk", "agents", "life"];
const PEOPLE = ["Sam", "Priya", "Jordan", "Mei", "Theo"];

const DECISIONS = [
  "Decided to keep the current approach for one more release.",
  "Agreed to write the outcome down as a lesson.",
  "Parked the bigger change until after the next release.",
  "Agreed on a smaller first step that ships this week.",
  "Moved the open question to the next check-in.",
  "Agreed the docs change ships with the code change, not after.",
];

const PROSE = [
  "The short version: small, boring pieces that each do one job are easier to trust.",
  "Most of the work was deciding what not to build.",
  "The first version was too clever; the second one is easier to read.",
  "Measuring first saved a week of guessing.",
  "It only became a habit once it was written down as a checklist.",
  "Two devices and a flaky network found more bugs than any unit test.",
  "The fix was one line; finding it took an afternoon.",
  "Writing the docs first exposed the confusing parts of the design.",
  "A dry run that prints a clear plan beats a fast run that surprises you.",
  "Every default here is the one I wanted on a slow train with no signal.",
  "Readers notice speed long before they notice features.",
  "Keeping the output folder readable made debugging almost pleasant.",
  "The sensors are honest; the problems are usually in how we read them.",
  "Agents are fast, but a narrow brief is what makes them useful.",
  "A good hand-off note is three lines: what changed, what ran, what is left.",
  "Nothing here needs a server you do not already have.",
  "Naming things well removed half the questions in review.",
  "The test that looked redundant caught the regression a month later.",
];

// ---------- orbit-notes ----------
function orbitNotes() {
  const P = "projects/orbit-notes/";
  const COMPONENTS = [
    "NoteList", "NoteEditor", "Sidebar", "TagPicker", "SyncBadge", "ConflictBanner", "SearchBox", "CommandPalette",
    "SettingsPanel", "NotebookTree", "PinButton", "ExportDialog", "EmptyState", "Toolbar", "DeviceList", "ShortcutHelp",
    "TrashView", "BacklinksPanel", "OutlineView", "WordCount", "ThemeToggle", "StatusBar", "Toast", "Modal",
    "ContextMenu", "Tooltip", "DatePicker", "TagChip", "Breadcrumbs", "SplitPane", "ResizeHandle", "OfflineNotice",
    "OnboardingTour", "FilterBar", "SortMenu", "NotePreview", "ImportDialog", "KeyboardHint", "NotebookPicker", "RelayStatus",
    "AttachmentList", "LinkPreview", "HistoryPanel", "MergeView", "FocusMode", "QuickCapture", "ReminderPicker", "ColorLabel",
  ];
  for (const name of COMPONENTS) {
    const label = cap(spaced(name));
    const hot = ["SyncBadge", "ConflictBanner", "RelayStatus", "MergeView"].includes(name);
    const a = hot ? num(0.3, 4) : num(3, 110);
    emit(P + "src/components/" + name + ".tsx", lines(
      "import { useState } from \"react\";",
      "import styles from \"./" + name + ".module.css\";",
      "",
      "export interface " + name + "Props {",
      "  className?: string;",
      "  defaultOpen?: boolean;",
      "}",
      "",
      "export function " + name + "({ className, defaultOpen = false }: " + name + "Props) {",
      "  const [open, setOpen] = useState(defaultOpen);",
      "  return (",
      "    <section className={[styles.root, className].filter(Boolean).join(\" \")} data-open={open}>",
      "      <button type=\"button\" aria-expanded={open} onClick={() => setOpen(!open)}>",
      "        " + label,
      "      </button>",
      "    </section>",
      "  );",
      "}",
    ), a);
    emit(P + "src/components/" + name + ".module.css", lines(
      ".root {",
      "  display: flex;",
      "  flex-direction: column;",
      "  gap: " + pick([4, 6, 8, 12]) + "px;",
      "}",
      "",
      ".root[data-open=\"true\"] {",
      "  background: var(--surface-2);",
      "  border-radius: var(--radius-" + pick(["sm", "md"]) + ");",
      "}",
    ), a + num(0, 2));
    emit(P + "tests/components/" + name + ".test.tsx", lines(
      "import { render, screen } from \"@testing-library/react\";",
      "import { describe, expect, it } from \"vitest\";",
      "import { " + name + " } from \"../../src/components/" + name + "\";",
      "",
      "describe(\"" + name + "\", () => {",
      "  it(\"renders its toggle\", () => {",
      "    render(<" + name + " />);",
      "    expect(screen.getByRole(\"button\", { name: \"" + label + "\" })).toBeTruthy();",
      "  });",
      "});",
    ), a + num(0, 3));
  }

  const SYNC = {
    hlc: "Hybrid logical clock: wall time, counter and device id.",
    "relay-client": "Talks to the relay over HTTPS with paging and retries.",
    oplog: "Append-only operation log on top of IndexedDB.",
    compaction: "Folds old operations into snapshots after 5,000 ops or on close.",
    backoff: "Retry timing for an unreachable relay.",
    worker: "Shared worker entry point for the web build.",
    protocol: "Message shapes for a sync round.",
    conflicts: "Detects same-field edits from two devices for the banner.",
    cursor: "Remembers the last remote stamp per relay.",
    batch: "Groups outgoing operations into pages of 500.",
  };
  for (const [name, doc] of Object.entries(SYNC)) {
    emit(P + "src/sync/" + name + ".ts", lines(
      "/** " + doc + " */",
      "import type { Op } from \"./schema\";",
      "",
      "export function " + camelOf(name) + "Step(ops: Op[]): Op[] {",
      "  return ops.filter((op) => op.noteId.length > 0);",
      "}",
    ), num(0.5, 12));
    emit(P + "tests/sync/" + name + ".test.ts", lines(
      "import { describe, expect, it } from \"vitest\";",
      "import { " + camelOf(name) + "Step } from \"../../src/sync/" + name + "\";",
      "",
      "describe(\"" + name + "\", () => {",
      "  it(\"keeps operations with a note id\", () => {",
      "    expect(" + camelOf(name) + "Step([])).toEqual([]);",
      "  });",
      "});",
    ), num(0.5, 14));
  }
  const MIGRATIONS = ["init", "tags_table", "notebooks", "trash", "tags_array", "pinned_field", "per_note_log"];
  MIGRATIONS.forEach((name, i) => {
    emit(P + "src/sync/migrations/" + String(i + 1).padStart(4, "0") + "_" + name + ".ts", lines(
      "import type { Migration } from \"./types\";",
      "",
      "export const migration: Migration = {",
      "  id: " + (i + 1) + ",",
      "  name: \"" + name + "\",",
      "  async up(db, { dryRun }) {",
      "    const plan = await db.plan(\"" + name + "\");",
      "    if (dryRun) return plan;",
      "    await db.apply(plan);",
      "    return plan;",
      "  },",
      "};",
    ), i === 6 ? num(1, 3) : 200 - i * 26 + num(0, 10));
  });
  emit(P + "src/sync/migrations/types.ts", lines(
    "export interface MigrationPlan {",
    "  changes: { noteId: string; field: string; from: unknown; to: unknown }[];",
    "}",
    "",
    "export interface MigrationDb {",
    "  plan(name: string): Promise<MigrationPlan>;",
    "  apply(plan: MigrationPlan): Promise<void>;",
    "}",
    "",
    "export interface Migration {",
    "  id: number;",
    "  name: string;",
    "  up(db: MigrationDb, opts: { dryRun: boolean }): Promise<MigrationPlan>;",
    "}",
  ), 9);

  for (const name of ["indexes", "idb", "notebooks", "tags", "trash", "search-index", "tokenizer", "export", "import"]) {
    emit(P + "src/store/" + name + ".ts", lines(
      "import type { Note } from \"./notes-store\";",
      "",
      "/** " + cap(name.replace("-", " ")) + " for the local note store. */",
      "export function " + camelOf(name) + "(notes: Note[]): Note[] {",
      "  return notes.slice();",
      "}",
    ), num(2, 80));
  }

  const HOOKS = ["Notes", "SyncState", "Debounce", "Hotkeys", "Online", "Search", "Notebook", "Tags", "Selection", "LocalSetting",
    "Theme", "Device", "Conflicts", "Autosave", "ScrollRestore", "Clipboard", "Dropzone", "MediaQuery", "Interval", "FocusTrap"];
  for (const h of HOOKS) {
    emit(P + "src/hooks/use" + h + ".ts", lines(
      "import { useEffect, useState } from \"react\";",
      "",
      "/** use" + h + ": " + spaced(h) + " state for the app shell. */",
      "export function use" + h + "<T>(initial: T) {",
      "  const [value, setValue] = useState<T>(initial);",
      "  useEffect(() => () => setValue(initial), [initial]);",
      "  return [value, setValue] as const;",
      "}",
    ), num(4, 120));
  }

  const UTILS = {
    clamp: "export function clamp(n: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, n));\n}",
    chunk: "export function chunk<T>(items: T[], size: number): T[][] {\n  const out: T[][] = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}",
    debounce: "export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  return (...args: A) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  };\n}",
    ids: "export function newId(prefix = \"n\"): string {\n  return prefix + \"_\" + crypto.randomUUID().split(\"-\").join(\"\").slice(0, 16);\n}",
    "word-count": "export function wordCount(text: string): number {\n  return text.split(/\\s+/).filter(Boolean).length;\n}",
    retry: "export async function retry<T>(fn: () => Promise<T>, tries = 3, waitMs = 250): Promise<T> {\n  let last: unknown;\n  for (let i = 0; i < tries; i++) {\n    try {\n      return await fn();\n    } catch (err) {\n      last = err;\n      await new Promise((r) => setTimeout(r, waitMs * 2 ** i));\n    }\n  }\n  throw last;\n}",
    dates: "export function dayKey(ms: number): string {\n  return new Date(ms).toISOString().slice(0, 10);\n}\n\nexport function isSameDay(a: number, b: number): boolean {\n  return dayKey(a) === dayKey(b);\n}",
    sort: "export function byUpdated<T extends { updatedAt: number }>(a: T, b: T): number {\n  return b.updatedAt - a.updatedAt;\n}",
    platform: "export const isMac = typeof navigator !== \"undefined\" && /Mac/.test(navigator.platform);\nexport const modKey = isMac ? \"Cmd\" : \"Ctrl\";",
  };
  const MORE_UTILS = ["throttle", "text", "paths", "assert", "logger", "storage-keys", "color", "keyboard", "markdown-lite", "diff-lines", "bytes"];
  for (const [name, body] of Object.entries(UTILS)) emit(P + "src/utils/" + name + ".ts", body, num(10, 160));
  for (const name of MORE_UTILS) {
    emit(P + "src/utils/" + name + ".ts", lines(
      "/** " + cap(name.replace("-", " ")) + " helpers used across orbit-notes. */",
      "export function " + camelOf(name) + "(input: string): string {",
      "  return input.trim();",
      "}",
    ), num(10, 160));
  }

  const DESKTOP = ["main", "tray", "menu", "ipc", "updater", "window-state", "shortcuts", "deep-links", "preload", "notifications"];
  for (const name of DESKTOP) {
    emit(P + "src/desktop/" + name + ".ts", lines(
      "// Desktop shell: " + name.replace("-", " ") + ".",
      "export function setup" + cap(camelOf(name)) + "(): void {",
      "  // wired up in main.ts",
      "}",
    ), num(6, 90));
  }
  for (const name of ["service-worker", "shared-worker", "install-prompt", "offline-cache", "storage-estimate", "visibility", "broadcast", "boot"]) {
    emit(P + "src/web/" + name + ".ts", lines(
      "// Web build: " + name.replace("-", " ") + ".",
      "export function " + camelOf(name) + "(): void {",
      "  // registered from boot.ts",
      "}",
    ), num(5, 100));
  }
  const I18N = {
    en: ["Synced", "Syncing", "Waiting for relay", "Sync paused", "New note", "Search", "Settings", "Trash", "Pinned"],
    de: ["Synchronisiert", "Synchronisiere", "Warte auf Relay", "Sync pausiert", "Neue Notiz", "Suchen", "Einstellungen", "Papierkorb", "Angeheftet"],
    fr: ["Synchronisé", "Synchronisation", "En attente du relais", "Synchro en pause", "Nouvelle note", "Rechercher", "Réglages", "Corbeille", "Épinglées"],
    es: ["Sincronizado", "Sincronizando", "Esperando al relé", "Sincronización en pausa", "Nueva nota", "Buscar", "Ajustes", "Papelera", "Fijadas"],
  };
  const KEYS = ["sync.idle", "sync.active", "sync.waiting", "sync.paused", "note.new", "nav.search", "nav.settings", "nav.trash", "nav.pinned"];
  for (const [lang, words] of Object.entries(I18N)) {
    const obj = {};
    KEYS.forEach((k, i) => { obj[k] = words[i]; });
    emit(P + "src/i18n/" + lang + ".json", JSON.stringify(obj, null, 2), num(2, 30));
  }
  for (const spec of ["offline-edit", "two-tabs", "conflict-banner", "pin-order", "export", "search", "settings", "onboarding", "trash-restore", "keyboard"]) {
    emit(P + "tests/e2e/" + spec + ".spec.ts", lines(
      "import { expect, test } from \"@playwright/test\";",
      "",
      "test(\"" + spec.replace("-", " ") + "\", async ({ page }) => {",
      "  await page.goto(\"http://localhost:5173\");",
      "  await expect(page.getByRole(\"heading\", { name: \"Orbit Notes\" })).toBeVisible();",
      "});",
    ), num(1, 40));
  }
  const ICONS = ["note", "notebook", "pin", "tag", "search", "settings", "trash", "sync", "sync-paused", "relay", "device", "export",
    "import", "history", "link", "attachment", "reminder", "focus", "outline", "backlinks", "filter", "sort", "check", "close",
    "chevron", "plus", "minus", "warning", "info", "offline"];
  for (const icon of ICONS) {
    const r = int(5, 8);
    emit(P + "public/icons/" + icon + ".svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\"><circle cx=\"12\" cy=\"12\" r=\"" + r + "\"/><path d=\"M" + (12 - r + 2) + " 12h" + (2 * r - 4) + "\"/></svg>", num(20, 160));
  }
  emit(P + "public/favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><circle cx=\"16\" cy=\"16\" r=\"6\" fill=\"#7fa6ff\"/><ellipse cx=\"16\" cy=\"16\" rx=\"14\" ry=\"5\" fill=\"none\" stroke=\"#a37cff\" stroke-width=\"2\"/></svg>", 140);
  emit(P + "public/manifest.webmanifest", JSON.stringify({ name: "Orbit Notes", short_name: "Orbit", start_url: "/", display: "standalone", background_color: "#0f1220", theme_color: "#7fa6ff", icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml" }] }, null, 2), 120);
  for (const s of ["desktop", "migrate", "release", "seed", "bench-merge", "check-bundle"]) {
    emit(P + "scripts/" + s + ".mjs", lines(
      "#!/usr/bin/env node",
      "// npm run " + s,
      "const args = process.argv.slice(2);",
      "console.log(\"" + s + "\", args.join(\" \"));",
    ), num(3, 60));
  }
  const SCREENS = ["note-list", "editor", "sync-badge", "conflict-banner", "settings", "search", "onboarding", "export", "tray-menu", "device-list", "focus-mode", "history"];
  for (const screen of SCREENS) {
    const versions = int(3, 7);
    for (let v = 1; v <= versions; v++) {
      const w = 360 + 40 * int(0, 12);
      emit(P + "design/mockups/" + screen + "-v" + v + ".svg", lines(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + w + " 640\">",
        "  <rect width=\"" + w + "\" height=\"640\" fill=\"#14161f\"/>",
        "  <rect x=\"16\" y=\"16\" width=\"" + (w - 32) + "\" height=\"48\" rx=\"8\" fill=\"#1f2333\"/>",
        "  <rect x=\"16\" y=\"80\" width=\"" + Math.round((w - 48) / 3) + "\" height=\"544\" rx=\"8\" fill=\"#1a1d2b\"/>",
        "  <text x=\"28\" y=\"46\" fill=\"#d9dce8\" font-family=\"system-ui\" font-size=\"16\">" + screen.replace(/-/g, " ") + " v" + v + "</text>",
        "</svg>",
      ), (versions - v) * num(4, 12) + num(0.5, 6));
    }
    emit(P + "design/specs/" + screen + ".md", lines(
      "# Spec: " + screen.replace(/-/g, " "),
      "",
      "Owner: Priya. Latest mockup: `design/mockups/" + screen + "-v" + versions + ".svg`.",
      "",
      "## States",
      "- empty, loading, offline, error, long content",
      "",
      "## Notes",
      "- " + pick(PROSE),
      "- Copy follows the " + link(P + "design/specs/" + screen + ".md", "notes/meetings/2026-10-30-design-review-sync-status.md", "sync status review") + ".",
    ), num(2, 40));
  }
  for (const topic of ["sync-trust", "pinned-notes", "export-habits", "search-expectations", "desktop-vs-web", "onboarding-dropoff", "keyboard-users", "tag-usage", "conflict-wording", "offline-scenarios"]) {
    emit(P + "design/research/" + topic + ".md", lines(
      "# Research: " + topic.replace(/-/g, " "),
      "",
      "Source: beta tester sessions run by Mei, " + int(4, 9) + " people.",
      "",
      "## What we saw",
      "- " + pick(PROSE),
      "- " + pick(PROSE),
      "",
      "Feeds into " + link(P + "design/research/" + topic + ".md", P + "docs/beta-feedback.md", "beta feedback") + ".",
    ), num(15, 140));
  }
  const ADRS = ["use-indexeddb", "hybrid-logical-clocks", "field-level-merge", "shared-worker-sync", "relay-paging", "compaction-policy",
    "paragraph-merge", "desktop-shell", "no-server-search", "per-note-oplog", "migrations-dry-run", "e2e-with-playwright", "i18n-json", "icon-set"];
  ADRS.forEach((name, i) => {
    const rel = P + "docs/adr/" + String(i + 1).padStart(4, "0") + "-" + name + ".md";
    emit(rel, lines(
      "# ADR " + (i + 1) + ": " + name.replace(/-/g, " "),
      "",
      "Status: " + (i === 9 || i === 10 ? "accepted, October 2026" : "accepted"),
      "",
      "## Context",
      pick(PROSE),
      "",
      "## Decision",
      cap(name.replace(/-/g, " ")) + ".",
      "",
      "## Consequences",
      "- " + pick(PROSE),
      "",
      "See " + wiki(P + "docs/architecture.md") + ".",
    ), 260 - i * 18 + num(0, 6));
  });
  const GUIDE = ["first-note", "notebooks", "tags", "pinning", "search", "keyboard-shortcuts", "sync-explained", "sync-status", "conflicts",
    "offline-use", "devices", "desktop-app", "web-app", "export", "import", "trash", "history", "focus-mode", "quick-capture",
    "reminders", "attachments", "settings", "privacy", "troubleshooting"];
  for (const g of GUIDE) {
    const rel = P + "docs/guide/" + g + ".md";
    emit(rel, lines(
      "# " + cap(g.replace(/-/g, " ")),
      "",
      pick(PROSE),
      "",
      "1. Open Orbit Notes.",
      "2. " + pick(["Press Ctrl+K and type the command name.", "Use the sidebar on the left.", "Right-click the note in the list.", "Open Settings from the menu."]),
      "3. " + pick(["Changes save as you type.", "The sync badge shows when it reached the relay.", "Nothing leaves this device until sync is on."]),
      "",
      "More: " + ref(rel, pick([P + "docs/sync-protocol.md", P + "docs/architecture.md", P + "docs/beta-feedback.md"])),
    ), g.startsWith("sync") || g === "conflicts" ? num(1, 5) : num(10, 120));
  }
  for (let minor = 1; minor <= 14; minor++) {
    const rel = P + "docs/releases/0." + minor + ".md";
    emit(rel, lines(
      "# orbit-notes 0." + minor,
      "",
      "- " + cap(pick(WORK.orbit)) + ".",
      "- " + cap(pick(WORK.orbit)) + ".",
      "",
      "Full list in the " + link(rel, P + "CHANGELOG.md", "changelog") + ".",
    ), (14 - minor) * 21 + num(2, 8));
  }
  for (let i = 0; i < 36; i++) {
    const t = dayAt(2026, 9, 1) + i * 2 * DAY;
    const kind = i % 2 ? "compaction" : "merge";
    emit(P + "bench/results/" + ymd(t) + "-" + kind + ".json", JSON.stringify({
      bench: kind,
      ops: kind === "merge" ? 10000 : 20000,
      medianMs: Math.round(num(kind === "merge" ? 18 : 140, kind === "merge" ? 34 : 260) * 10) / 10,
      p95Ms: Math.round(num(kind === "merge" ? 40 : 300, kind === "merge" ? 70 : 520) * 10) / 10,
      node: "22.11.0",
      commit: hex(7),
    }, null, 2), ageAt(t + 17 * 3600000));
  }
  emit(P + ".env.example", lines(
    "# Copy to .env.local for development. Placeholder values only.",
    "RELAY_URL=http://localhost:8787",
    "RELAY_DEVICE_NAME=dev-laptop",
    "SYNC_PAGE_SIZE=500",
  ), 40);
  emit(P + ".github/workflows/release.yml", lines(
    "name: release",
    "on:",
    "  push:",
    "    tags: [\"v*\"]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 22",
    "      - run: npm ci",
    "      - run: npm run build",
  ), 30);
}

// ---------- tidepool ----------
function tidepool() {
  const P = "projects/tidepool/";
  const STATIONS = {
    "st-01": ["temp_c", "humidity_pct", "wind_ms", "pressure_hpa"],
    "st-02": ["temp_c", "humidity_pct", "water_level_m"],
    "st-03": ["temp_c", "humidity_pct", "wind_ms"],
    "st-04": ["temp_c", "humidity_pct", "wind_ms", "pressure_hpa"],
    "st-05": ["temp_c", "water_level_m"],
    "st-06": ["temp_c", "humidity_pct", "water_level_m"],
  };
  const RANGE = { temp_c: [8, 17, 1], humidity_pct: [60, 95, 1], wind_ms: [0.4, 13, 1], pressure_hpa: [996, 1025, 1], water_level_m: [0.3, 2.7, 2] };
  for (let t = dayAt(2026, 9, 18); t <= dayAt(2026, 11, 1); t += DAY) {
    for (const [st, metrics] of Object.entries(STATIONS)) {
      const rows = ["station,ts_utc,metric,value,battery_v"];
      const battery = num(3.62, 3.98).toFixed(2);
      for (const minute of [0, 5, 10]) {
        for (const m of metrics) {
          const [lo, hi, dp] = RANGE[m];
          rows.push(st + "," + ymd(t) + "T00:" + pad(minute) + ":00Z," + m + "," + num(lo, hi).toFixed(dp) + "," + battery);
        }
      }
      emit(P + "samples/" + st + "-" + ymd(t) + ".csv", rows.join("\n"), ageAt(t + DAY + 20 * 60000));
    }
  }
  const NOTEBOOKS = ["calibration-st-04", "storm-october", "wind-roses", "humidity-drift", "tide-vs-pressure", "battery-health",
    "gap-analysis", "qc-flag-review", "seasonal-baseline", "sensor-comparison", "rollup-sanity", "dashboard-prototypes"];
  for (const nb of NOTEBOOKS) {
    const code = "import duckdb\ncon = duckdb.connect(\"tidepool.duckdb\", read_only=True)\ncon.sql(\"select station, metric, count(*) from clean_readings group by 1, 2\").show()";
    emit(P + "notebooks/" + nb + ".ipynb", JSON.stringify({
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["# " + cap(nb.replace(/-/g, " ")) + "\n", "\n", "Exploration notebook. Findings go into the weekly station report.\n"] },
        { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: code.split("\n").map((l, i, a) => (i < a.length - 1 ? l + "\n" : l)) },
      ],
      metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    }, null, 1), num(2, 70));
  }
  const SQL = {
    station_health: "select station, max(ts_utc) as last_seen, min(battery_v) as min_battery\nfrom raw_readings\nwhere ts_utc >= now() - interval 1 day\ngroup by station\norder by station;",
    gaps: "select station, ts_utc, lead(ts_utc) over (partition by station order by ts_utc) - ts_utc as gap\nfrom raw_readings\nqualify gap > interval 15 minute;",
    flags_by_rule: "select rule, station, count(*) as flags\nfrom qc_flags\nwhere ts_utc >= ?\ngroup by rule, station\norder by flags desc;",
    battery_trend: "select station, cast(ts_utc as date) as day, avg(battery_v) as battery\nfrom raw_readings\ngroup by 1, 2\norder by 1, 2;",
    hourly_rollup: "select station, metric, date_trunc('hour', ts_utc) as hour, avg(value) as value\nfrom clean_readings\nwhere ts_utc >= ?\ngroup by 1, 2, 3;",
    wind_max: "select station, cast(ts_utc as date) as day, max(value) as gust\nfrom clean_readings\nwhere metric = 'wind_ms'\ngroup by 1, 2;",
    water_level_extremes: "select station, min(value) as low, max(value) as high\nfrom clean_readings\nwhere metric = 'water_level_m' and ts_utc >= ?\ngroup by station;",
    export_week: "copy (select * from daily_station where day >= ?) to 'exports/week.parquet' (format parquet);",
    schema: "create table if not exists qc_flags (\n  station text, metric text, ts_utc timestamp, rule text, detail text\n);\ncreate table if not exists daily_station (\n  station text, day date, metric text, min_value double, avg_value double, max_value double, readings integer\n);",
    views: "create or replace view clean_readings as\nselect r.* from raw_readings r\nwhere not exists (\n  select 1 from qc_flags f\n  where f.station = r.station and f.metric = r.metric and f.ts_utc = r.ts_utc\n);",
    dedupe: "delete from raw_readings\nwhere rowid not in (\n  select min(rowid) from raw_readings group by station, ts_utc, metric\n);",
    compare_stations: "select a.day, a.avg_value as jetty, b.avg_value as lighthouse\nfrom daily_station a join daily_station b using (day, metric)\nwhere a.station = 'st-01' and b.station = 'st-04' and metric = ?;",
  };
  for (const [name, body] of Object.entries(SQL)) emit(P + "sql/" + name + ".sql", "-- " + name.replace(/_/g, " ") + "\n" + body, num(3, 120));
  const MODULES = {
    cli: "\"\"\"Command line: tidepool ingest | qc | rollup.\"\"\"\n\nimport typer\n\napp = typer.Typer(help=\"Coastal weather sensor pipeline\")\n\n\n@app.command()\ndef ingest(folder: str = \"inbox\") -> None:\n    print(\"ingesting\", folder)\n",
    config: "\"\"\"Settings read from the environment.\"\"\"\n\nimport os\n\nDUCKDB_PATH = os.environ.get(\"DUCKDB_PATH\", \"tidepool.duckdb\")\nGATEWAY_INBOX = os.environ.get(\"GATEWAY_INBOX\", \"inbox\")\n",
    gateway: "\"\"\"Reads the gateway's drop folder.\"\"\"\n\nfrom pathlib import Path\n\n\ndef new_files(inbox: Path) -> list[Path]:\n    return sorted(p for p in inbox.glob(\"*.csv\") if p.stat().st_size > 0)\n",
    units: "\"\"\"Unit conversions for display.\"\"\"\n\n\ndef c_to_f(c: float) -> float:\n    return c * 9 / 5 + 32\n\n\ndef ms_to_knots(ms: float) -> float:\n    return ms * 1.943844\n",
    stations: "\"\"\"Station list and sensor layout.\"\"\"\n\nSTATIONS = {\n    \"st-01\": \"North jetty\",\n    \"st-02\": \"Harbor wall\",\n    \"st-03\": \"Dune path\",\n    \"st-04\": \"Lighthouse\",\n    \"st-05\": \"Boat ramp\",\n    \"st-06\": \"Salt marsh\",\n}\n",
    alerts: "\"\"\"Push alerts through a local ntfy server.\"\"\"\n\nimport urllib.request\n\n\ndef notify(topic: str, message: str, base: str = \"http://localhost:8090\") -> None:\n    req = urllib.request.Request(base + \"/\" + topic, data=message.encode(), method=\"POST\")\n    urllib.request.urlopen(req, timeout=5)\n",
    export: "\"\"\"Exports for sharing a week of data.\"\"\"\n\n\ndef export_week(con, day) -> None:\n    con.execute(open(\"sql/export_week.sql\").read(), [day])\n",
    timeutil: "\"\"\"Times are stored in UTC and shown in local time.\"\"\"\n\nfrom datetime import datetime, timezone\n\n\ndef utc_now() -> datetime:\n    return datetime.now(timezone.utc)\n",
    storage: "\"\"\"Opens the DuckDB file.\"\"\"\n\nimport duckdb\n\nfrom .config import DUCKDB_PATH\n\n\ndef connect(read_only: bool = False) -> duckdb.DuckDBPyConnection:\n    return duckdb.connect(DUCKDB_PATH, read_only=read_only)\n",
    schema: "\"\"\"Creates tables and views from sql/schema.sql and sql/views.sql.\"\"\"\n\nfrom pathlib import Path\n\nSQL_DIR = Path(__file__).parent.parent / \"sql\"\n\n\ndef ensure(con) -> None:\n    for name in (\"schema.sql\", \"views.sql\"):\n        con.execute((SQL_DIR / name).read_text())\n",
  };
  for (const [name, body] of Object.entries(MODULES)) emit(P + "tidepool/" + name + ".py", body, num(3, 90));
  const TESTS = ["ingest", "rollup", "units", "stations", "gateway", "timeutil", "alerts", "schema", "export", "config", "cli", "gaps"];
  for (const name of TESTS) {
    emit(P + "tests/test_" + name + ".py", lines(
      "import pytest",
      "",
      "",
      "def test_" + name + "_smoke():",
      "    assert " + (name === "units" ? "round(32.0, 1) == 32.0" : "\"" + name + "\""),
      "",
      "",
      "@pytest.mark.parametrize(\"station\", [\"st-01\", \"st-04\"])",
      "def test_" + name + "_station_ids(station):",
      "    assert station.startswith(\"st-\")",
    ), num(3, 100));
  }
  for (const page of ["1_Overview", "2_Stations", "3_Water_level", "4_Wind", "5_QC_flags", "6_Gaps"]) {
    emit(P + "dashboard/pages/" + page + ".py", lines(
      "import streamlit as st",
      "",
      "st.title(\"" + page.slice(2).replace(/_/g, " ") + "\")",
      "st.caption(\"Daily rollups from tidepool.duckdb\")",
    ), num(4, 60));
  }
  for (const comp of ["station_picker", "metric_chart", "flag_table", "battery_gauge"]) {
    emit(P + "dashboard/components/" + comp + ".py", lines(
      "import streamlit as st",
      "",
      "",
      "def " + comp + "(data):",
      "    st.write(data)",
    ), num(4, 60));
  }
  const DOCS = {
    "data-dictionary": "Every table and column, with units.",
    "qc-rules": "Range, flat-line and spike rules, with thresholds per metric.",
    gateway: "How the LoRa gateway writes files into the inbox.",
    deployment: "Where the pipeline runs and how the nightly jobs are scheduled.",
    alerts: "Which conditions send a push and when quiet hours apply.",
    faq: "Short answers for people reading the dashboard.",
  };
  for (const [name, desc] of Object.entries(DOCS)) {
    const rel = P + "docs/" + name + ".md";
    emit(rel, lines("# " + cap(name.replace(/-/g, " ")), "", desc, "", "- " + pick(PROSE), "", "Related: " + link(rel, P + "docs/pipeline.md", "pipeline") + ", " + wiki(P + "docs/sensors.md")), num(5, 90));
  }
  for (let month = 5; month <= 10; month++) {
    let t = dayAt(2026, month, 1);
    while (new Date(t).getUTCDay() !== 6) t += DAY;
    for (const st of pickN(Object.keys(STATIONS), 3)) {
      const rel = P + "docs/station-visits/" + ymd(t) + "-" + st + ".md";
      emit(rel, lines(
        "# Visit: " + st + ", " + longDate(t),
        "",
        "Mei, " + clock(int(8, 11), pick([0, 15, 30, 45])) + ".",
        "",
        "- Battery " + num(3.55, 3.98).toFixed(2) + " V",
        "- " + pick(["Cleaned the radiation shield.", "Tightened the mast clamp.", "Replaced the desiccant pack.", "Checked the tide gauge zero against the staff gauge.", "Cleared salt from the anemometer cups."]),
        "- " + pick(["No faults found.", "Logger clock was 40 seconds fast; reset.", "Solar panel output normal.", "Antenna cable re-seated."]),
        "",
        "Station list: " + wiki(P + "docs/sensors.md"),
      ), ageAt(t + 15 * 3600000));
    }
  }
  for (let t = dayAt(2026, 5, 4); t <= dayAt(2026, 11, 2); t += 7 * DAY) {
    const rel = P + "reports/weekly-" + ymd(t) + ".md";
    const rows = Object.keys(STATIONS).map((st) => "| " + st + " | " + num(96.5, 100).toFixed(1) + "% | " + int(0, 14) + " |");
    emit(rel, lines(
      "# Station report, week ending " + shortDate(t - DAY),
      "",
      "| Station | Uptime | QC flags |",
      "|---|---|---|",
      rows,
      "",
      "Notes: " + pick(WORK.tide) + ".",
      "",
      "Rules: " + link(rel, P + "docs/qc-rules.md", "QC rules") + ". Stations: " + wiki(P + "docs/sensors.md") + ".",
    ), ageAt(t + 8 * 3600000));
  }
  for (const st of Object.keys(STATIONS)) {
    emit(P + "firmware/" + st + ".toml", lines(
      "[station]",
      "id = \"" + st + "\"",
      "interval_s = 300",
      "",
      "[radio]",
      "spreading_factor = " + pick([7, 8, 9]),
      "tx_power_dbm = " + pick([10, 14]),
      "",
      "[calibration]",
      "temp_offset_c = " + (st === "st-04" ? "-0.6" : "0.0"),
    ), st === "st-04" ? 24 : num(40, 160));
  }
  emit(P + ".env.example", lines(
    "# Placeholder values for local development.",
    "DUCKDB_PATH=./tidepool.duckdb",
    "GATEWAY_INBOX=./inbox",
    "NTFY_TOPIC=tidepool-demo",
  ), 60);
}

// ---------- paper-lantern ----------
function paperLantern() {
  const P = "projects/paper-lantern/";
  const SRC = ["cli", "serve", "watch", "cache", "slug", "dates", "tags", "paginate", "sitemap", "robots", "atom", "excerpt",
    "toc", "footnotes", "highlight", "images", "partials", "config", "drafts", "links", "redirects"];
  for (const name of SRC) {
    emit(P + "src/" + name + ".js", lines(
      "// paper-lantern: " + name + ".",
      "export function " + camelOf(name) + "(site, posts = []) {",
      "  return posts.filter((p) => !p.draft);",
      "}",
    ), name === "cache" || name === "footnotes" || name === "atom" ? num(1, 6) : num(6, 150));
  }
  for (const name of SRC.slice(0, 15)) {
    emit(P + "test/" + name + ".test.js", lines(
      "import { test } from \"node:test\";",
      "import assert from \"node:assert/strict\";",
      "import { " + camelOf(name) + " } from \"../src/" + name + ".js\";",
      "",
      "test(\"" + name + " skips drafts\", () => {",
      "  const out = " + camelOf(name) + "({}, [{ draft: true }, { draft: false }]);",
      "  assert.equal(out.length, 1);",
      "});",
    ), num(2, 120));
  }
  emit(P + "bin/lantern.js", lines(
    "#!/usr/bin/env node",
    "import { build } from \"../src/build.js\";",
    "",
    "const [command = \"build\"] = process.argv.slice(2);",
    "if (command === \"build\") {",
    "  const result = await build({ root: process.cwd() });",
    "  console.log(\"built \" + result.posts + \" posts, \" + result.rebuilt + \" changed\");",
    "}",
  ), 12);
  const THEMES = {
    plain: ["#ffffff", "#1b1b1f", "#5b5e6b", "#2f6fdb"],
    margin: ["#fbfaf7", "#22211f", "#6f6a62", "#a8462b"],
    dusk: ["#14161f", "#d9dce8", "#8a90a8", "#f2b46d"],
    notebook: ["#f6f4ec", "#2b2a26", "#77736a", "#3d7a5a"],
    harbor: ["#0f1a24", "#d4e2ee", "#7f95a8", "#5fc4c8"],
    lamplight: ["#1c1712", "#efe2cc", "#a8957a", "#e8a33d"],
    quiet: ["#fafafa", "#333333", "#888888", "#555555"],
    mono: ["#111111", "#e6e6e6", "#9a9a9a", "#ffffff"],
  };
  for (const [theme, [bg, text, muted, accent]] of Object.entries(THEMES)) {
    const T = P + "themes/" + theme + "/";
    const a = theme === "dusk" ? num(1, 5) : num(20, 200);
    emit(T + "theme.json", JSON.stringify({ name: theme, version: "0.9.0", colors: { background: bg, text, muted, accent }, partials: ["header", "footer"] }, null, 2), a);
    emit(T + "layout.html", lines(
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "  <meta charset=\"utf-8\">",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
      "  <title>{{ title }}</title>",
      "  <link rel=\"stylesheet\" href=\"/style.css\">",
      "  <link rel=\"alternate\" type=\"application/feed+json\" href=\"/feed.json\">",
      "</head>",
      "<body class=\"" + theme + "\">",
      "  {{> header }}",
      "  <main>{{ body }}</main>",
      "  {{> footer }}",
      "</body>",
      "</html>",
    ), a);
    emit(T + "post.html", lines("<article class=\"post\">", "  <h1>{{ title }}</h1>", "  <time datetime=\"{{ date }}\">{{ date }}</time>", "  {{ body }}", "</article>"), a);
    emit(T + "index.html", lines("<ul class=\"posts\">", "  {{#each posts}}", "  <li><a href=\"/{{ slug }}/\">{{ title }}</a> <time>{{ date }}</time></li>", "  {{/each}}", "</ul>"), a);
    emit(T + "tag.html", lines("<h1>Posts tagged {{ tag }}</h1>", "<ul class=\"posts\">", "  {{#each posts}}", "  <li><a href=\"/{{ slug }}/\">{{ title }}</a></li>", "  {{/each}}", "</ul>"), a);
    emit(T + "style.css", lines(
      ":root {",
      "  --bg: " + bg + ";",
      "  --text: " + text + ";",
      "  --muted: " + muted + ";",
      "  --accent: " + accent + ";",
      "}",
      "body { background: var(--bg); color: var(--text); font: 18px/1.6 Georgia, serif; margin: 0; }",
      "main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem; }",
      "a { color: var(--accent); }",
      "time { color: var(--muted); font: 14px system-ui, sans-serif; }",
    ), a);
    emit(T + "partials/header.html", "<header><a href=\"/\">{{ site.title }}</a></header>", a);
    emit(T + "partials/footer.html", "<footer><a href=\"/feed.json\">Feed</a> · Built with paper-lantern</footer>", a);
  }
  const TOPICS = ["local-first apps", "hybrid logical clocks", "static sites", "tide gauges", "DuckDB", "flaky tests", "git worktrees",
    "release notes", "CLI design", "Markdown footnotes", "dark themes", "sensor batteries", "service workers", "IndexedDB",
    "hand-off notes", "small tools", "code review", "lockfiles", "Node 22", "Python packaging with uv", "LoRa radios",
    "weather boxes", "writing docs", "keyboard shortcuts", "offline search", "dependency bumps", "CI caches", "conference talks",
    "time zones", "JSON Feed"];
  const FORMS = [
    (x) => "Notes on " + x,
    (x) => "What I learned from " + x,
    (x) => "A small guide to " + x,
    (x) => "Living with " + x,
    (x) => cap(x) + ", one year in",
    (x) => "Getting " + x + " right",
    (x) => "Three mistakes with " + x,
    (x) => cap(x) + " without the headaches",
  ];
  const TAGS = ["sync", "sensors", "writing", "tools", "agents", "release", "meta", "css", "python", "node"];
  const HEADINGS = ["What worked", "What did not", "The setup", "Numbers", "Next", "Why bother"];
  let prev = null;
  let t = dayAt(2025, 9, 2);
  let n = 0;
  while (t <= dayAt(2026, 10, 30)) {
    n++;
    const weekNotes = n % 6 === 0;
    const title = weekNotes ? "Week notes: " + shortDate(t) : pick(FORMS)(pick(TOPICS));
    const rel = P + "content/posts/" + ymd(t) + "-" + slugify(title) + ".md";
    emit(rel, lines(
      "---",
      "title: \"" + title + "\"",
      "date: " + ymd(t),
      "tags: [" + pickN(TAGS, 2).join(", ") + "]",
      "summary: \"" + pick(PROSE) + "\"",
      "---",
      "",
      pick(PROSE) + " " + pick(PROSE),
      "",
      "## " + pick(HEADINGS),
      "",
      pick(PROSE) + " " + pick(PROSE) + " " + pick(PROSE),
      prev ? ["", "Previously: " + link(rel, prev.rel, prev.title)] : [],
    ), ageAt(t + int(9, 20) * 3600000));
    prev = { rel, title };
    t += int(2, 4) * DAY;
  }
  for (const page of ["about", "uses", "colophon", "archive", "projects", "contact"]) {
    emit(P + "content/pages/" + page + ".md", lines(
      "---",
      "title: " + cap(page),
      "---",
      "",
      page === "contact" ? "Write to hello@example.org. Replies are slow but real." : pick(PROSE),
    ), num(30, 240));
  }
  const DOCS = ["getting-started", "configuration", "templates", "feeds", "deploy", "drafts", "tags", "pagination", "images",
    "footnotes", "cli", "incremental-builds", "migrating", "faq", "contributing"];
  for (const d of DOCS) {
    const rel = P + "docs/" + d + ".md";
    emit(rel, lines(
      "# " + cap(d.replace(/-/g, " ")),
      "",
      pick(PROSE),
      "",
      "```json",
      JSON.stringify({ title: "My site", theme: pick(Object.keys(THEMES)), postsPerPage: pick([10, 20]) }, null, 2),
      "```",
      "",
      "See also: " + wiki(P + "docs/themes.md") + ", " + link(rel, P + "docs/release-0.9.md", "the 0.9 plan") + ".",
    ), d === "feeds" || d === "incremental-builds" ? num(1, 4) : num(8, 160));
  }
  const RECIPES = ["reading-time", "custom-404", "series-of-posts", "syntax-highlighting", "draft-previews", "feed-to-email",
    "static-hosting", "redirects", "social-cards", "tag-clouds", "multi-language", "search-without-js"];
  for (const r of RECIPES) {
    const rel = P + "docs/recipes/" + r + ".md";
    emit(rel, lines("# Recipe: " + r.replace(/-/g, " "), "", "1. " + pick(PROSE), "2. Add a partial under `themes/<name>/partials/`.", "3. Rebuild with `npx lantern build`.", "", "Theme format: " + link(rel, P + "docs/themes.md", "themes")), num(10, 200));
  }
  for (const site of ["tiny", "tags", "drafts", "footnotes", "unicode", "big-images"]) {
    const F = P + "fixtures/" + site + "/";
    emit(F + "lantern.json", JSON.stringify({ title: "Fixture " + site, theme: "plain" }, null, 2), num(20, 200));
    for (let i = 1; i <= 5; i++) {
      emit(F + "content/posts/post-" + i + ".md", lines("---", "title: Fixture post " + i, "date: 2026-01-0" + i, site === "drafts" && i > 3 ? "draft: true" : "tags: [fixture]", "---", "", site === "footnotes" ? "Text with a note.[^1]\n\n[^1]: The note." : "Body " + i + "."), num(20, 200));
    }
  }
}

// ---------- fieldkit ----------
function fieldkit() {
  const P = "projects/fieldkit/";
  const LIB = ["config", "paths", "hash", "walk", "prune", "output", "json", "platform", "ignore", "progress", "errors", "version", "companions", "disk", "git"];
  for (const name of LIB) {
    emit(P + "src/lib/" + name + ".js", lines(
      "// fk internals: " + name + ".",
      "export function " + camelOf(name) + "(input) {",
      "  return input;",
      "}",
    ), num(4, 140));
  }
  for (const name of ["config", "completion", "version"]) {
    emit(P + "src/commands/" + name + ".js", lines("export async function " + name + "(opts = {}) {", "  console.log(\"fk " + name + "\", JSON.stringify(opts));", "}"), num(10, 120));
  }
  const CHECKS = ["node", "python", "git", "disk", "ntfy", "karakeep", "path-length", "line-endings"];
  for (const c of CHECKS) {
    emit(P + "checks/" + c + ".js", lines(
      "export const name = \"" + c + "\";",
      "",
      "export async function run() {",
      "  return { ok: true, detail: \"" + c + " looks fine\" };",
      "}",
    ), num(2, 60));
  }
  for (const name of ["sync-plan", "sync-delete", "snap-id", "snap-prune", "snap-restore", "doctor-json", "doctor-exit-code", "config", "ignore",
    "hash", "walk", "paths", "output", "companions", "version"]) {
    emit(P + "test/" + name + ".test.js", lines(
      "import { test } from \"node:test\";",
      "import assert from \"node:assert/strict\";",
      "",
      "test(\"" + name.replace(/-/g, " ") + "\", () => {",
      "  assert.ok(true);",
      "});",
    ), num(2, 120));
  }
  for (const fixture of ["sync-basic", "sync-delete", "sync-unicode", "sync-spaces", "snap-restore", "snap-prune", "doctor-json", "ignore-rules"]) {
    const F = P + "test/fixtures/" + fixture + "/";
    const count = int(6, 10);
    for (let i = 1; i <= count; i++) {
      const kind = i % 3;
      const file = kind === 0 ? "nested/item-" + i + ".json" : kind === 1 ? "file-" + i + ".txt" : "note-" + i + ".md";
      emit(F + file, kind === 0 ? JSON.stringify({ id: i, fixture }, null, 2) : "fixture " + fixture + " item " + i, num(30, 200));
    }
  }
  const DOCS = ["install", "configuration", "sync-rules", "snap-retention", "doctor-checks", "json-output", "exit-codes", "troubleshooting", "plugins-rfc", "release-process"];
  for (const d of DOCS) {
    const rel = P + "docs/" + d + ".md";
    emit(rel, lines("# " + cap(d.replace(/-/g, " ")), "", pick(PROSE), "", "- " + pick(WORK.fk) + ".", "", "Command reference: " + wiki(P + "docs/commands.md") + "."), num(4, 150));
  }
  emit(P + "CHANGELOG.md", lines(
    "# Changelog",
    "",
    "## 1.4.0",
    "- `fk doctor --json` for HQ.",
    "- Disk space check.",
    "",
    "## 1.3.0",
    "- `fk snap --restore`.",
    "",
    "## 1.2.0",
    "- `fk sync --dry-run` prints a plan.",
  ), 5);
}

// ---------- agent-playbook ----------
function agentPlaybook() {
  const P = "projects/agent-playbook/";
  const DOCS = ["handoff-notes", "skills-vs-subagents", "usage-windows", "privacy-boundaries", "when-to-split-work", "reviewing-agent-prs",
    "memory-files", "lesson-format", "routines", "ring-pages", "eval-habits", "worktree-cleanup", "naming-branches", "context-files",
    "failure-modes", "timeouts", "small-briefs", "coordinator-loop"];
  for (const d of DOCS) {
    const rel = P + "docs/" + d + ".md";
    emit(rel, lines(
      "# " + cap(d.replace(/-/g, " ")),
      "",
      pick(PROSE),
      "",
      "- " + cap(pick(WORK.agents)) + ".",
      "- " + pick(PROSE),
      "",
      "## What changed my mind",
      pick(PROSE),
      "",
      "Related: " + ref(rel, pick(CORE.agents)) + ".",
    ), num(2, 120));
  }
  const PLAYBOOKS = ["schema-migration", "new-skill", "skill-gotcha", "weekly-review", "inbox-zero", "dependency-advisory", "broken-main",
    "backup-restore-drill", "theme-release", "docs-pass", "beta-feedback-round", "station-outage", "talk-prep", "relay-upgrade", "node-upgrade", "new-project-setup"];
  for (const p of PLAYBOOKS) {
    const rel = P + "playbooks/" + p + ".md";
    emit(rel, lines(
      "# Playbook: " + p.replace(/-/g, " "),
      "",
      "1. Write the goal and the done-condition in one line each.",
      "2. " + cap(pick(WORK[pick(AREAS)])) + ".",
      "3. Hand long runs to a worker in its own worktree.",
      "4. Record anything surprising as a lesson.",
      "",
      "Lanes: " + wiki(P + "docs/lanes.md") + ".",
    ), num(3, 140));
  }
  const PROMPTS = ["review-a-migration", "summarize-a-pr", "draft-a-reply", "explain-a-flaky-test", "write-release-notes", "triage-an-issue",
    "standup-from-commits", "weekly-review", "dependency-risk", "design-critique", "write-a-runbook", "split-a-task", "handoff-note",
    "lesson-from-incident", "skill-gotcha", "doc-pass", "test-plan", "refactor-plan", "commit-message", "changelog-entry",
    "station-report", "theme-review", "radar-sweep", "inbox-summary", "talk-outline", "post-outline", "readme-pass", "api-sketch",
    "bug-repro", "scope-check", "merge-plan", "backup-check", "ci-failure", "rename-plan", "deprecation-note", "migration-guide"];
  for (const p of PROMPTS) {
    emit(P + "prompts/" + p + ".md", lines(
      "# Prompt: " + p.replace(/-/g, " "),
      "",
      "## Goal",
      cap(p.replace(/-/g, " ")) + " for {{project}}.",
      "",
      "## Constraints",
      "- Touch only the files named in {{scope}}.",
      "- Drafts only; never send or publish.",
      "",
      "## Done when",
      "- {{done_condition}}",
      "",
      "## Report",
      "Files changed, commands run, what is left.",
    ), num(2, 150));
  }
  for (const p of PROMPTS.slice(0, 30)) {
    emit(P + "evals/" + p + ".yaml", lines(
      "description: \"" + p.replace(/-/g, " ") + " stays on task\"",
      "prompts:",
      "  - file://../prompts/" + p + ".md",
      "providers:",
      "  - id: local-default",
      "tests:",
      "  - vars:",
      "      project: orbit-notes",
      "      scope: src/sync",
      "      done_condition: tests pass",
      "    assert:",
      "      - type: contains",
      "        value: \"Files changed\"",
      "      - type: not-contains",
      "        value: \"sent\"",
    ), num(2, 90));
  }
  const LANES = ["claude", "codex", "copilot", "opencode", "claude-api"];
  const TASKS = ["merge-test-race", "schema-v7-review", "dusk-sidebar", "json-feed-tests", "fk-doctor-disk", "qc-spike-window", "triage-prompt-evals",
    "compaction-bench", "pin-order-fix", "docs-pass-themes", "station-report", "lockfile-review", "standup-draft", "release-notes-draft",
    "search-worker", "tray-icon", "gap-report", "snap-prune-test", "ci-node-pin", "conflict-banner-copy"];
  const RESULTS = ["merged", "merged", "merged", "needs review", "parked"];
  for (let i = 0; i < 120; i++) {
    const t = dayAt(2026, 6, 1) + int(0, 153) * DAY;
    const lane = pick(LANES);
    const task = pick(TASKS);
    const rel = P + "runs/" + ymd(t) + "-" + lane + "-" + task + ".md";
    const hour = int(9, 18);
    emit(rel, lines(
      "# Hand-off: " + task.replace(/-/g, " "),
      "",
      "- **Lane:** " + { claude: "Claude Code", codex: "Codex", copilot: "Copilot", opencode: "OpenCode", "claude-api": "Claude API" }[lane],
      "- **Worktree:** ../" + task,
      "- **Started:** " + longDate(t) + ", " + clock(hour, pick([0, 10, 20, 30, 40, 50])),
      "- **Result:** " + pick(RESULTS),
      "",
      "## Changed",
      "- " + pick(["src/sync/merge.ts", "src/sync/compaction.ts", "themes/dusk/style.css", "src/feed.js", "src/commands/doctor.js", "tidepool/qc.py", "prompts/triage-an-issue.md"]),
      "",
      "## Ran",
      "- " + pick(["npm test", "uv run pytest", "node --test test/", "npx playwright test", "promptfoo eval"]) + " (" + int(18, 240) + " passed)",
      "",
      "## Left",
      "- " + pick(PROSE),
      "",
      "Lesson check: " + ref(rel, pick(CORE.agents)),
    ), ageAt(t + (hour + 1) * 3600000));
  }
  const PATTERNS = ["plan-then-run", "narrow-brief", "name-the-forbidden-files", "done-condition", "report-format", "second-reader",
    "worktree-per-task", "drafts-not-sends", "lesson-after-incident", "quarantine-then-fix", "lockfile-first", "fallback-lane"];
  for (const p of PATTERNS) {
    emit(P + "patterns/" + p + ".md", lines("# Pattern: " + p.replace(/-/g, " "), "", pick(PROSE), "", "Example: " + pick(WORK.agents) + "."), num(5, 160));
  }
  const CHECKLISTS = ["before-a-parallel-run", "before-merging-agent-work", "new-skill", "skill-gotcha", "routine-setup", "ring-page",
    "lesson-entry", "worker-brief", "fallback-lane", "eval-run", "privacy-check", "handoff-review", "weekly-review", "release-day-agents",
    "inbox-run", "dependency-run"];
  for (const c of CHECKLISTS) {
    const rel = P + "checklists/" + c + ".md";
    emit(rel, lines(
      "# Checklist: " + c.replace(/-/g, " "),
      "",
      "- [ ] Goal and done-condition written down",
      "- [ ] " + cap(pick(WORK.agents)),
      "- [ ] Drafts only; nothing sent",
      "- [ ] Lesson added if something surprised you",
      "",
      "Lanes: " + ref(rel, pick(CORE.agents)),
    ), num(3, 130));
  }
}

// ---------- notes ----------
function notes() {
  // daily journal
  for (let t = dayAt(2026, 5, 4); t <= dayAt(2026, 11, 1); t += DAY) {
    const skip = chance(0.1);
    const areas = pickN(AREAS, int(2, 3));
    const tomorrow = chance(0.35) ? pick(WORK[pick(["orbit", "tide", "lantern"])]) : null;
    const hour = int(19, 22);
    if (skip) continue;
    const rel = "notes/journal/" + ymd(t) + ".md";
    emit(rel, lines(
      "# " + longDate(t),
      "",
      areas.map((a) => "- " + cap(pick(WORK[a])) + "."),
      tomorrow ? "- Tomorrow: " + tomorrow + "." : [],
      "",
      "Links: " + areas.map((a) => ref(rel, pick(CORE[a]))).join(", "),
    ), ageAt(t + hour * 3600000));
  }
  // meetings
  const MEETINGS = [
    ["orbit", "orbit-notes sync check-in", ["Sam"]],
    ["orbit", "orbit-notes web build review", ["Priya"]],
    ["orbit", "orbit-notes desktop shell", ["Sam", "Theo"]],
    ["orbit", "orbit-notes search planning", ["Sam", "Priya"]],
    ["orbit", "orbit-notes beta planning", ["Mei"]],
    ["tide", "tidepool station review", ["Mei"]],
    ["tide", "tidepool dashboard review", ["Priya"]],
    ["tide", "tidepool storm debrief", ["Mei"]],
    ["lantern", "paper-lantern docs sync", ["Jordan"]],
    ["lantern", "paper-lantern feeds", ["Jordan", "Theo"]],
    ["lantern", "paper-lantern theme check-in", ["Priya", "Jordan"]],
    ["fk", "fieldkit roadmap", ["Theo"]],
    ["fk", "fieldkit snapshot retention", ["Theo"]],
    ["agents", "agent lanes review", []],
    ["agents", "skill review", []],
    ["agents", "prompt eval results", ["Theo"]],
    ["life", "monthly planning", PEOPLE],
    ["life", "conference talk prep", ["Jordan"]],
  ];
  for (let i = 0; i < 40; i++) {
    let t = dayAt(2026, 5, 4) + int(0, 175) * DAY;
    while (isWeekend(t)) t += DAY;
    const [area, title, people] = pick(MEETINGS);
    const hour = int(9, 16);
    const minute = pick([0, 0, 30]);
    const rel = "notes/meetings/" + ymd(t) + "-" + slugify(title) + ".md";
    const owner = people.length ? pick(people) : "Me";
    emit(rel, lines(
      "# " + cap(title),
      "",
      longDate(t) + ", " + clock(hour, minute) + ". " + (people.length ? people.join(", ") + ", me." : "Just me, with the agent lanes view open."),
      "",
      "## Notes",
      "- " + cap(pick(WORK[area])) + ".",
      "- " + cap(pick(WORK[area])) + ".",
      "- " + pick(DECISIONS),
      "",
      "## Action items",
      "- " + owner + ": " + pick(WORK[area]),
      "- Me: " + pick(WORK[area]),
      "",
      "Related: " + ref(rel, pick(CORE[area])),
    ), ageAt(t + (hour + 1) * 3600000));
  }
  // ideas
  const IDEAS = [
    ["notebook-sharing", "orbit", "Share one notebook between two people's devices with a separate relay key."],
    ["markdown-export-format", "orbit", "Export each note as a Markdown file with front matter for tags and pinned state."],
    ["relay-self-hosting", "orbit", "A one-file relay people can run on a small home server."],
    ["tide-predictions-overlay", "tide", "Overlay predicted tides on the measured water level chart."],
    ["station-map", "tide", "A small map page with the six stations and their last reading."],
    ["lantern-webmentions", "lantern", "Collect replies from other sites at build time, no scripts on the page."],
    ["lantern-image-pipeline", "lantern", "Resize and convert images during the build, with a cache."],
    ["fk-watch-mode", "fk", "fk sync --watch for a folder that changes all day."],
    ["skill-usage-stats", "agents", "Count how often each skill runs and where it hits friction."],
    ["routine-failure-digest", "agents", "One morning line per failed routine, with the log path."],
  ];
  for (const [slug, area, text] of IDEAS) {
    const rel = "notes/ideas/" + slug + ".md";
    emit(rel, lines(
      "# Idea: " + slug.replace(/-/g, " "),
      "",
      text,
      "",
      "- " + pick(PROSE),
      "- Fits after: " + pick(WORK[area]) + ".",
      "",
      "Related: " + ref(rel, pick(CORE[area])),
    ), num(4, 120));
  }
  // drafts
  const DRAFTS = ["hlc-in-one-page", "what-sensors-taught-me", "agent-lanes", "release-notes-people-read", "small-tools", "a-year-of-week-notes",
    "dark-themes-for-reading", "dry-runs-everywhere", "the-boring-relay", "notes-on-handoffs"];
  for (const d of DRAFTS) {
    const rel = "notes/drafts/" + d + ".md";
    emit(rel, lines("# Draft: " + d.replace(/-/g, " "), "", pick(PROSE) + " " + pick(PROSE), "", "## Points", "- " + pick(PROSE), "- " + pick(PROSE), "", "Status: " + pick(["outline", "first draft", "second draft", "waiting for Jordan's edit"]) + "."), num(1, 90));
  }
  // reading notes
  const READING = ["local-first-essay", "hlc-paper", "text-merge-survey", "duckdb-csv-sniffing", "tide-gauge-drift", "worktrees-for-agents",
    "release-notes-guide", "talk-with-live-code", "small-tools", "time-zones", "testing-flaky-tests", "lockfile-hygiene",
    "service-worker-caching", "indexeddb-performance", "lora-range-tests", "writing-runbooks"];
  for (const r of READING) {
    const rel = "notes/reading/" + r + ".md";
    const area = pick(["orbit", "tide", "lantern", "agents"]);
    emit(rel, lines("# Reading: " + r.replace(/-/g, " "), "", "## Takeaways", "- " + pick(PROSE), "- " + pick(PROSE), "", "## How it applies", "- " + cap(pick(WORK[area])) + ".", "", "From the " + link(rel, "notes/reading-list.md", "reading list") + ". Related: " + ref(rel, pick(CORE[area]))), num(5, 150));
  }
}

// ---------- ops ----------
function ops() {
  for (let t = dayAt(2026, 7, 5); t <= dayAt(2026, 11, 1); t += DAY) {
    const files = 2100 + Math.floor(ageAt(t) * -2) + int(240, 300);
    const size = num(380, 430).toFixed(1);
    const d = ymd(t);
    const stamp = (m, s) => d + "T23:" + pad(m) + ":" + pad(s) + "Z";
    emit("ops/backups/logs/" + d + ".log", lines(
      stamp(0, int(1, 9)) + " backup start target=workspace",
      stamp(int(2, 4), int(10, 59)) + " copied files=" + files + " size_mb=" + size,
      stamp(5, int(0, 9)) + " backup start target=tidepool-duckdb",
      stamp(5, int(20, 59)) + " copied files=1 size_mb=" + num(70, 95).toFixed(1),
      stamp(6, int(0, 30)) + " verify ok",
      stamp(6, int(31, 59)) + " done",
    ), ageAt(t + 23 * 3600000 + 7 * 60000));
  }
  const RUNBOOKS = ["relay-down", "ci-runner-full", "disk-almost-full", "rollback-a-release", "gateway-reboot", "restore-relay-store",
    "routine-failed", "map-looks-stale", "node-upgrade", "python-upgrade", "ntfy-silent", "changedetection-noisy"];
  for (const r of RUNBOOKS) {
    const rel = "ops/runbooks/" + r + ".md";
    emit(rel, lines("# Runbook: " + r.replace(/-/g, " "), "", "1. Check the last good state in HQ.", "2. " + pick(PROSE), "3. Fix, then write down what happened.", "", "Backups: " + ref(rel, "ops/backups/backup-plan.md")), num(5, 150));
  }
  const PROJECTS = [["orbit-notes", "node"], ["paper-lantern", "node"], ["fieldkit", "node"], ["tidepool", "python"]];
  for (let i = 0; i < 80; i++) {
    const t = dayAt(2026, 8, 20) + int(0, 73) * DAY;
    const [project, runtime] = pick(PROJECTS);
    const failed = chance(0.12) ? int(1, 3) : 0;
    const finished = t + int(9, 20) * 3600000 + int(0, 59) * 60000;
    emit("ops/ci/runs/" + ymd(t) + "-" + project + "-" + hex(6) + ".json", JSON.stringify({
      project,
      workflow: "ci",
      branch: chance(0.6) ? "main" : "pr-" + int(40, 260),
      commit: hex(7),
      status: failed ? "failed" : "passed",
      durationSeconds: int(70, 420),
      runtime: runtime === "node" ? "node 22.11" : "python 3.12",
      tests: { passed: int(40, 260), failed, skipped: int(0, 4) },
      finishedAt: new Date(finished).toISOString(),
    }, null, 2), ageAt(finished));
  }
  for (let t = dayAt(2026, 6, 14); t <= dayAt(2026, 11, 1); t += 7 * DAY) {
    const rel = "ops/hq/weekly/" + ymd(t) + ".md";
    emit(rel, lines(
      "# HQ week ending " + longDate(t),
      "",
      "- Routines run: " + int(150, 175) + ", failed: " + int(0, 3),
      "- New lessons: " + int(0, 3) + ", new gotchas: " + int(0, 4),
      "- Busiest lane: " + pick(["Claude Code", "Codex", "OpenCode"]),
      "",
      "Index: " + ref(rel, "memory/MEMORY.md"),
    ), ageAt(t + 18 * 3600000 + 5 * 60000));
  }
  const INCIDENTS = [
    ["2026-06-11", "relay-cert-expired"], ["2026-06-29", "gateway-power-loss"], ["2026-07-15", "ci-cache-stale"],
    ["2026-07-30", "backup-disk-full"], ["2026-08-18", "duplicate-ingest"], ["2026-09-03", "broken-main-two-pushes"],
    ["2026-09-21", "dashboard-clock-change"], ["2026-10-05", "routine-timeout"], ["2026-10-17", "worktree-overwrite"], ["2026-10-23", "pinned-notes-migration"],
  ];
  for (const [d, slug] of INCIDENTS) {
    const rel = "ops/incidents/" + d + "-" + slug + ".md";
    const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    emit(rel, lines(
      "# Incident: " + slug.replace(/-/g, " "),
      "",
      longDate(t) + ", noticed at " + clock(int(7, 21), pick([5, 20, 35, 50])) + ".",
      "",
      "## What happened",
      pick(PROSE),
      "",
      "## What changed",
      "- " + pick(DECISIONS),
      "",
      "Lessons index: " + ref(rel, "memory/MEMORY.md"),
    ), ageAt(t + 22 * 3600000));
  }
}

// ---------- re-stamp the hand-written core ----------
const HOT = {
  "notes/now.md": 0.15,
  "AGENTS.md": 1.8,
  "CLAUDE.md": 5.5,
  "README.md": 12,
  "projects/paper-lantern/CHANGELOG.md": 3.1,
  "projects/paper-lantern/docs/release-0.9.md": 3.05,
  "projects/orbit-notes/src/sync/merge.ts": 0.9,
  "projects/orbit-notes/src/sync/schema.ts": 1.1,
  "projects/orbit-notes/src/sync/engine.ts": 1.3,
  "projects/orbit-notes/src/app/App.tsx": 2.2,
  "memory/MEMORY.md": 2.4,
};
function restampCore() {
  let n = 0;
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel + "/");
        continue;
      }
      if (!e.isFile() || emitted.has(rel)) continue;
      let age = HOT[rel];
      if (age === undefined) {
        const m = rel.match(/(\d{4})-(\d{2})-(\d{2})/);
        age = m ? ageAt(Date.UTC(+m[1], +m[2] - 1, +m[3], 17, 30)) : 0.5 + (fnv(rel) % 2000) / 100;
      }
      const when = new Date(NOW - Math.max(120000, age * DAY));
      fs.utimesSync(path.join(dir, e.name), when, when);
      n++;
    }
  };
  walk(ROOT, "");
  return n;
}

// ---------- run ----------
orbitNotes();
tidepool();
paperLantern();
fieldkit();
agentPlaybook();
notes();
ops();
const restamped = restampCore();
const ms = Number(process.hrtime.bigint() - started) / 1e6;
console.log("workspace-gen: " + created + " created, " + kept + " already there, " + restamped + " core files re-stamped, " + emitted.size + " generated paths in " + Math.round(ms) + " ms");
