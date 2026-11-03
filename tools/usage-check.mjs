#!/usr/bin/env node
// Usage gate for agents: reads HQ's /api/stats and says whether new work may start.
// Exit 0 ok, 3 low, 4 stale/unknown/unmetered, 2 bad args. --hook mode is quiet and always exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { WINDOWS, UNMETERED, meterVerdict } = createRequire(import.meta.url)('../lib/usage-verdict.cjs');   // shared with the WORKER BENCH widget
const args = process.argv.slice(2);
const hook = args.includes('--hook');
const json = args.includes('--json');
const report = args.includes('--report');
const agentArg = args.find(x => x.startsWith('--agent='));
const agent = agentArg ? agentArg.slice(8).trim() : '';
const thresholdArg = args.find(x => x.startsWith('--threshold='));
const parsedThreshold = Number(thresholdArg ? thresholdArg.slice(12) : 90);
const threshold = Number.isFinite(parsedThreshold) ? parsedThreshold : 90;
const USAGE = 'Usage: node tools/usage-check.mjs --agent=<claude|codex|copilot|opencode|deepseek|kilo> [--threshold=90] [--json] [--hook] [--report --used=<0-100> [--resets=<iso>] [--week=<0-100>] [--week-resets=<iso>]]';
const LOW_MESSAGE = 'Start nothing new: finish or park edits, write the usage handoff (see HQ-HANDOFF.md Usage watcher).';
const DISTRUST_MESSAGE = "Reading not trustworthy: use the agent's own readout (Claude /usage, Codex /status, Copilot readout) and say so in the report.";
const UNMETERED_MESSAGE = 'no meter; report usage as unmetered and watch for rate-limit errors';

if (!(agent in WINDOWS) && !UNMETERED.includes(agent)) {
  if (hook) process.exit(0);
  console.error(USAGE);
  process.exit(2);
}
if (report && (!(agent in WINDOWS) || hook)) {
  console.error('--report requires a metered agent and cannot be combined with --hook');
  console.error(USAGE);
  process.exit(2);
}

// One shape for every answer, filled in by the rules below.
const result = fields => ({
  agent, window: null, used: null, threshold, verdict: 'unknown', estimated: false,
  stale: false, idle: false, resetsAt: null, ageMinutes: null, message: DISTRUST_MESSAGE, ...fields
});

const valueOf = name => args.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
const cacheFile = () => path.join(os.tmpdir(), `hq-usage-check-${agent}.json`);
const port = () => Number(process.env.HQ_PORT || process.env.PORT) || 50000;

function reportWindow(label, usedName, resetName) {
  const raw = valueOf(usedName), used = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(used) || used < 0 || used > 100) throw new Error(`--${usedName} must be from 0 to 100`);
  const reset = valueOf(resetName);
  if (reset !== undefined && !Number.isFinite(Date.parse(reset))) throw new Error(`--${resetName} must be an ISO time`);
  return { label, used, ...(reset === undefined ? {} : { resetsAt: reset }) };
}

async function sendReport() {
  const windows = [reportWindow(agent === 'copilot' ? 'credits' : '5h', 'used', 'resets')];
  if (valueOf('week') !== undefined) {
    if (agent === 'copilot') throw new Error('--week is only valid for Claude or Codex');
    windows.push(reportWindow('week', 'week', 'week-resets'));
  } else if (valueOf('week-resets') !== undefined) throw new Error('--week-resets requires --week');
  const response = await fetch(`http://localhost:${port()}/local/usage-reading`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, windows, source: 'usage-check' }), signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    let detail = ''; try { detail = (await response.json()).error || ''; } catch { }
    throw new Error(detail || `HQ HTTP ${response.status}`);
  }
  try { fs.rmSync(cacheFile(), { force: true }); } catch { }
}

async function read() {
  if (UNMETERED.includes(agent)) return result({ verdict: 'unmetered', message: UNMETERED_MESSAGE });
  try {
    const response = await fetch(`http://localhost:${port()}/api/stats?fresh=1`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HQ HTTP ${response.status}`);
    const stats = await response.json();
    const meter = (stats.meters || []).find(m => m.id === agent);
    if (!meter) return result({ window: WINDOWS[agent] });
    const v = meterVerdict(meter, WINDOWS[agent], { threshold });
    if (v.verdict === 'unknown') return result({ window: WINDOWS[agent] });
    return result({ ...v, message: v.verdict === 'low' ? LOW_MESSAGE : v.verdict === 'stale' ? DISTRUST_MESSAGE : '' });
  } catch { return result({ window: WINDOWS[agent] }); }
}

function resetsText(resetsAt) {
  if (!Number.isFinite(resetsAt)) return '';
  const remaining = resetsAt - Date.now();
  if (remaining <= 0) return 'resets now';
  return `resets in ${Math.floor(remaining / 3600000)}h${Math.floor((remaining % 3600000) / 60000)}m`;
}

function format(r) {
  if (r.verdict === 'unmetered') return [`usage ${r.agent} unmetered: ${r.message}`];
  const line = `usage ${r.agent} ${r.window || WINDOWS[r.agent]}=${r.used === null ? '?' : `${r.used}%`} ${r.verdict}`
    + (r.estimated ? ' (estimated)' : '')
    + (r.idle ? ' (idle since reading)' : '')
    + (r.verdict !== 'unknown' && resetsText(r.resetsAt) ? ` ${resetsText(r.resetsAt)}` : '');
  const lines = [line];
  if (r.verdict === 'low') lines.push(LOW_MESSAGE);
  if (r.verdict === 'stale' || r.verdict === 'unknown') lines.push(DISTRUST_MESSAGE);
  return lines;
}

// Hook path: reuse a 5 minute old reading so most tool calls skip the network entirely.
async function cached() {
  const file = cacheFile();
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.result && Date.now() - saved.ts < 300000) return saved.result;
  } catch { /* no cache yet */ }
  const fresh = await read();
  try { if (fresh.verdict !== 'unknown') fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), result: fresh })); } catch { /* cache is best effort */ }
  return fresh;
}

try {
  if (report) await sendReport();
  const r = hook ? await cached() : await read();
  if (hook) {
    if (r.verdict === 'low' || r.verdict === 'stale') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: format(r).join(' ') } }));
    }
    process.exitCode = 0;
  } else if (json) {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.verdict === 'ok' ? 0 : r.verdict === 'low' ? 3 : 4;
  } else {
    for (const line of format(r)) console.log(line);
    process.exitCode = r.verdict === 'ok' ? 0 : r.verdict === 'low' ? 3 : 4;
  }
} catch (error) {
  if (!hook) { console.error(report ? `usage report failed: ${error.message}` : 'usage check failed'); process.exitCode = report && /^--/.test(error.message) ? 2 : 4; }
}
