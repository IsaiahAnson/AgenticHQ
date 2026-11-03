#!/usr/bin/env node
/*
 * demo/usage-gen.mjs
 *
 * Writes a month of made-up usage to the demo sandbox's snapshots/usage-log.jsonl
 * (the format in USAGE.md), so the Second Brain's Skills, Applications and Routines
 * tabs have numbers to size things by. refresh/usage.mjs then turns it into
 * data/arms-usage.js, exactly as it would for a real log.
 *
 *   node demo/usage-gen.mjs <demo sandbox dir>
 *
 * - Deterministic: one seeded RNG; times are relative to the moment it runs.
 * - Safe: writes one file, and only inside a folder tools/demo.mjs made.
 *
 * Every skill, routine and app in here is the demo's own; nothing is measured.
 */

import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] || ".");
if (!fs.existsSync(path.join(dir, ".agentic-hq-demo"))) {
  console.error(`${dir} is not a demo sandbox (no .agentic-hq-demo marker).`);
  process.exit(1);
}

let seed = 20261102;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
const DAY = 864e5, now = Date.now(), lines = [];
const at = (daysAgo, hour, minute = 0) => { const d = new Date(now - daysAgo * DAY); d.setHours(hour, minute + between(0, 9), between(0, 59), 0); return d; };
/* tokens priced at a flat blended API rate, the way the session-log reader reports them */
const push = (when, kind, name, tokens) => {
  if (when.getTime() > now) return;
  const e = { at: when.toISOString(), kind, name };
  if (tokens) Object.assign(e, { tokens, cost: +(tokens * 6e-6).toFixed(4) });
  lines.push(e);
};

/* skills: [name, runs in 30 days, tokens per run] */
const SKILLS = [["ship", 9, [90e3, 260e3]], ["pr-review", 14, [30e3, 80e3]], ["test-fixer", 11, [40e3, 140e3]], ["triage", 18, [12e3, 40e3]],
  ["release-notes", 4, [20e3, 50e3]], ["standup", 20, [6e3, 15e3]], ["dep-watch", 7, [25e3, 60e3]], ["design-critique", 5, [30e3, 90e3]],
  ["weekly-review", 4, [35e3, 70e3]], ["brain-refresh", 6, [8e3, 20e3]]];
for (const [name, runs, [lo, hi]] of SKILLS)
  for (let i = 0; i < runs; i++) push(at(between(0, 29), between(9, 21), between(0, 50)), "skill", name, between(lo, hi));

/* routines: [id, hours it fires, which days (0 = Sunday), tokens per run or 0 for HQ-server routines] */
const DAILY = [0, 1, 2, 3, 4, 5, 6], WEEKDAYS = [1, 2, 3, 4, 5];
const ROUTINES = [["rt:morning-brief", [7], DAILY, [18e3, 30e3]], ["rt:inbox-triage", [9, 13, 17], DAILY, [9e3, 22e3]],
  ["rt:standup-notes", [9], WEEKDAYS, [5e3, 11e3]], ["rt:dependency-watch", [10], DAILY, [20e3, 45e3]], ["rt:radar-sweep", [8, 20], DAILY, 0],
  ["rt:release-notes-draft", [15], [5], [25e3, 40e3]], ["rt:skill-review", [9], [1], [30e3, 55e3]], ["rt:weekly-review", [18], [0], 0],
  ["rt:backup-check", [23], DAILY, 0], ["rt:brain-refresh", [2, 5, 8, 11, 14, 17, 20, 23], DAILY, 0]];
for (const [id, hours, days, tok] of ROUTINES)
  for (let ago = 0; ago < 30; ago++) {
    if (!days.includes(new Date(now - ago * DAY).getDay())) continue;
    for (const h of hours) {
      if (id === "rt:backup-check" && ago === 1) continue;   // the one missed fire the homepage warns about
      push(at(ago, h, 0), "routine", id, tok ? between(tok[0], tok[1]) : 0);
    }
  }

/* apps (config/apps.json ids): [id, calls on a typical day] */
const APPS = [["app:gh", 14], ["app:gmail-connector", 6], ["app:gcal", 3], ["app:playwright", 4], ["app:codex", 2], ["app:copilot", 1],
  ["app:opencode", 1], ["app:claude-api", 5], ["app:vercel", 1]];
for (const [id, perDay] of APPS)
  for (let ago = 0; ago < 30; ago++) {
    const calls = Math.max(0, Math.round(perDay * (0.3 + rand() * 1.4)) - (rand() < 0.25 ? perDay : 0));
    if (calls) lines.push({ at: at(ago, between(9, 20)).toISOString(), kind: "app", name: id, calls });
  }

lines.sort((a, b) => a.at.localeCompare(b.at));
fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
fs.writeFileSync(path.join(dir, "snapshots", "usage-log.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
console.log(`usage-gen: ${lines.length} usage lines`);
