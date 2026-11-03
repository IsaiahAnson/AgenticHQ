#!/usr/bin/env node
// Repairs AI Radar text stored as CP437 mojibake ("ΓÇö" for "—"), which deepseek-ask.ps1 wrote until 2026-11-01.
// Standings go through lib/standings.cjs load/save, run files and latest.json through writeJsonAtomic (the writer
// ai-radar.mjs uses). Ids, keys, urls, refs and aliases are left alone. A second run finds nothing to fix.
//   node tools/radar-fix-mojibake.mjs [--dry-run] [--dir <radar data dir>]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROOT, writeJsonAtomic } from './ai-radar.mjs';

const require = createRequire(import.meta.url);
const standings = require('../lib/standings.cjs');
const { fixDeep } = require('../lib/mojibake.cjs');

const IDENTITY = ['id', 'key', 'url', 'refs', 'aliases'];

// A run in progress owns these files; status.json names its pid.
function radarRunning(dir) {
  let status = null;
  try { status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); } catch (_) { return false; }
  if (!status || status.running !== true || !status.pid) return false;
  try { process.kill(status.pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function fixRadarMojibake({ dir = path.join(ROOT, 'data', 'radar'), dryRun = false } = {}) {
  if (radarRunning(dir)) throw Object.assign(new Error('AI Radar is running (status.json); try again after it finishes.'), { code: 'RADAR_RUNNING' });
  const files = [];
  const repair = (name, value) => {
    const changes = [];
    const fixed = fixDeep(value, { skip: IDENTITY, onFix: (at, before, after) => changes.push({ at, before, after }) });
    if (changes.length) files.push({ name, changes });
    return changes.length ? fixed : null;
  };
  const standingsFile = path.join(dir, 'standings.json');
  if (fs.existsSync(standingsFile)) {
    const fixed = repair('standings.json', standings.load(standingsFile, 'radar'));
    if (fixed && !dryRun) standings.save(standingsFile, fixed);
  }
  const runsDir = path.join(dir, 'runs');
  const runs = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(f => f.endsWith('.json')).sort().map(f => `runs/${f}`) : [];
  for (const name of ['latest.json', ...runs]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    const fixed = repair(name, JSON.parse(fs.readFileSync(file, 'utf8')));
    if (fixed && !dryRun) writeJsonAtomic(file, fixed);
  }
  return { dryRun, files, count: files.reduce((n, f) => n + f.changes.length, 0) };
}

export function formatReport(report) {
  const clip = s => (s.length > 120 ? s.slice(0, 119) + '…' : s), count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = [`Radar mojibake${report.dryRun ? ' dry run' : ''}: ${count(report.count, 'string')} in ${count(report.files.length, 'file')} ${report.dryRun ? 'to fix' : 'fixed'}.`];
  for (const f of report.files) {
    lines.push(`${f.name}: ${f.changes.length}`);
    for (const c of f.changes) lines.push(`  ${c.at}`, `    ${clip(c.before)}`, `    -> ${clip(c.after)}`);
  }
  if (!report.count) lines.push('No changes.');
  return lines.join('\n');
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const args = process.argv.slice(2), at = args.indexOf('--dir'), dir = at >= 0 ? args[at + 1] : null;
  const unknown = args.filter((arg, i) => arg !== '--dry-run' && !(at >= 0 && (i === at || i === at + 1)));
  if (unknown.length || (at >= 0 && !dir)) {
    console.error('Usage: node tools/radar-fix-mojibake.mjs [--dry-run] [--dir <radar data dir>]');
    process.exitCode = 2;
  } else {
    try {
      console.log(formatReport(fixRadarMojibake({ dryRun: args.includes('--dry-run'), ...(dir ? { dir: path.resolve(dir) } : {}) })));
    } catch (err) {
      console.error(err.message);
      process.exitCode = err.code === 'RADAR_RUNNING' ? 3 : 1;
    }
  }
}
