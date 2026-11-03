#!/usr/bin/env node
// Week in HQ facts (P6): gathers the week's numbers into one JSON file a Sunday routine turns into a page.
//   node tools/week-in-hq.mjs [--days 7] [--out os-runs/week-facts.json] [--fixture <dir>] [--now <iso>]
// Live sources: GET /api/outcomes on this HQ, os-runs/routine-outcomes.jsonl, artifacts/*.json sidecars,
// data/artifact-opens.jsonl, data/radar/runs/*.json, data/radar/decisions.json, git commits since the window
// start (tools/ingest/commits.mjs), the local ActivityWatch server and snapshots/youtube-pulse.jsonl.
// --fixture reads the same inputs from flat JSON/JSONL files in one dir and touches no network or disk state.
// Every missing or broken source becomes an empty input; the run still writes a page-worthy file. No model calls.
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { extractCommits } from './ingest/commits.mjs';

const require = createRequire(import.meta.url);
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { collect } = require('../lib/week-facts.cjs');
const { hoursByApp } = require('../lib/activitywatch.cjs');
const DAY = 86400000;
const API_TIMEOUT_MS = 30000; // /api/outcomes is slow on a cold cache

function parseArgs(argv) {
  const options = { days: 7, out: null, fixture: null, now: null };
  const take = (index, name, inline) => {
    if (inline) return inline;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--days' || arg.startsWith('--days=')) {
      options.days = Number(take(i, '--days', arg.includes('=') ? arg.slice(7) : ''));
      if (!arg.includes('=')) i += 1;
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      options.out = take(i, '--out', arg.includes('=') ? arg.slice(6) : '');
      if (!arg.includes('=')) i += 1;
    } else if (arg === '--fixture' || arg.startsWith('--fixture=')) {
      options.fixture = take(i, '--fixture', arg.includes('=') ? arg.slice(10) : '');
      if (!arg.includes('=')) i += 1;
    } else if (arg === '--now' || arg.startsWith('--now=')) {
      options.now = take(i, '--now', arg.includes('=') ? arg.slice(6) : '');
      if (!arg.includes('=')) i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.days) || options.days < 1) throw new Error('--days must be a positive number');
  options.days = Math.round(options.days);
  if (!options.out) options.out = path.join(KIT, 'os-runs', 'week-facts.json');
  if (options.fixture) options.fixture = path.resolve(options.fixture);
  return options;
}

/* ---------- readers: a missing or broken file is an empty input ---------- */
const listOf = value => (Array.isArray(value) ? value : []);

async function readText(file) {
  try {
    return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

async function readJson(file, fallback) {
  const raw = await readText(file);
  if (raw === null || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readJsonl(file) {
  const raw = await readText(file);
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* blank or half-written line: skip it */
    }
  }
  return rows;
}

async function readJsonDir(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names.filter(entry => /\.json$/i.test(entry)).sort()) {
    const value = await readJson(path.join(dir, name), null);
    if (value !== null) rows.push({ name, value });
  }
  return rows;
}

async function fetchOutcomes() {
  const port = process.env.PORT || 50000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/outcomes`, { signal: controller.signal });
    if (!response.ok) return [];
    const payload = await response.json();
    return listOf(payload && payload.outcomes);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function liveInputs({ now, days }) {
  const sidecars = await readJsonDir(path.join(KIT, 'artifacts'));
  const radarRuns = (await readJsonDir(path.join(KIT, 'data', 'radar', 'runs')))
    .map(({ value }) => value)
    .filter(value => value && typeof value === 'object' && !Array.isArray(value));
  let commits = [];
  try {
    commits = listOf(await extractCommits({ since: new Date(now - days * DAY) }));
  } catch {
    commits = [];
  }
  let activity = null;
  try {
    activity = await hoursByApp({ days, now });
  } catch {
    activity = null;
  }
  return {
    outcomes: await fetchOutcomes(),
    routineOutcomes: await readJsonl(path.join(KIT, 'os-runs', 'routine-outcomes.jsonl')),
    artifacts: sidecars
      .filter(({ value }) => value && typeof value === 'object' && !Array.isArray(value))
      .map(({ name, value }) => ({ file: name.replace(/\.json$/i, '.html'), title: value.title, created: value.created })),
    artifactOpens: await readJsonl(path.join(KIT, 'data', 'artifact-opens.jsonl')),
    radarRuns,
    radarDecisions: await readJson(path.join(KIT, 'data', 'radar', 'decisions.json'), {}),
    commits,
    activity,
    youtube: await readJsonl(path.join(KIT, 'snapshots', 'youtube-pulse.jsonl'))
  };
}

async function fixtureInputs(dir) {
  const file = name => path.join(dir, name);
  const activity = await readJson(file('activity.json'), null);
  return {
    outcomes: listOf(await readJson(file('outcomes.json'), [])),
    routineOutcomes: await readJsonl(file('routine-outcomes.jsonl')),
    artifacts: listOf(await readJson(file('artifacts.json'), [])),
    artifactOpens: await readJsonl(file('artifact-opens.jsonl')),
    radarRuns: listOf(await readJson(file('radar-runs.json'), [])),
    radarDecisions: await readJson(file('decisions.json'), {}),
    commits: listOf(await readJson(file('commits.json'), [])),
    activity: activity && typeof activity === 'object' ? activity : null,
    youtube: await readJsonl(file('youtube-pulse.jsonl'))
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = options.now ? Date.parse(options.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error('--now must be an ISO date');
  const out = path.resolve(options.out);
  const inputs = options.fixture ? await fixtureInputs(options.fixture) : await liveInputs({ now, days: options.days });
  const facts = collect({ now, days: options.days, ...inputs });

  await mkdir(path.dirname(out), { recursive: true });
  const temp = `${out}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(facts, null, 2)}\n`, 'utf8');
  await rename(temp, out);
  console.log(`week-facts: ${out} (${facts.shipping.commits} commits, ${facts.agents.runs} agent runs)`);
}

try {
  await main();
} catch (error) {
  console.error(`week-facts: ${error.message || error}`);
  process.exitCode = 1;
}
