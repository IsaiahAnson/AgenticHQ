#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* the bundles tools/repo-backup.ps1 writes: os-config.json backup.root (a folder) and backup.repos (repo folder names) */
const BACKUP = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'os-config.json'), 'utf8')).backup || {}; } catch { return {}; } })();
const BACKUP_ROOT = BACKUP.root || path.join(os.homedir(), 'AgenticHQ-backups');
const REPOS = Array.isArray(BACKUP.repos) && BACKUP.repos.length ? BACKUP.repos : [path.basename(ROOT)];
const rank = { pass: 0, warn: 1, fail: 2 };

export function summarizeChecks(checks) {
  const rows = checks.map(row => ({ status: rank[row.status] === undefined ? 'fail' : row.status, check: String(row.check), detail: String(row.detail) }));
  return { rows, exitCode: rows.reduce((code, row) => Math.max(code, rank[row.status]), 0) };
}

export function formatTable(rows) {
  const widths = [6, 18, 0];
  for (const row of rows) { widths[0] = Math.max(widths[0], row.status.length); widths[1] = Math.max(widths[1], row.check.length); }
  const line = (a, b, c) => `${a.padEnd(widths[0])}  ${b.padEnd(widths[1])}  ${c}`;
  return [line('STATUS', 'CHECK', 'DETAIL'), line('-'.repeat(widths[0]), '-'.repeat(widths[1]), '------'), ...rows.map(row => line(row.status.toUpperCase(), row.check, row.detail))].join('\n');
}

async function jsonFetch(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function healthCheck() {
  try {
    const h = await jsonFetch('http://localhost:50000/api/health');
    const down = Object.entries(h.companions || {}).filter(([, ok]) => !ok).map(([name]) => name);
    const failed = !h.engine || !h.workspaceSet || h.runner !== 'ready' || down.length;
    return { status: failed ? 'fail' : 'pass', check: 'health', detail: failed ? `engine=${!!h.engine}, workspace=${!!h.workspaceSet}, runner=${h.runner || 'unknown'}, companions down=${down.join(',') || 'none'}` : `engine and ${Object.keys(h.companions || {}).length} companions ready` };
  } catch (error) { return { status: 'fail', check: 'health', detail: error.message }; }
}

function usageChecks() {
  const script = path.join(ROOT, 'tools', 'usage-check.mjs');
  return ['claude', 'codex', 'copilot'].map(agent => {
    const run = spawnSync(process.execPath, [script, `--agent=${agent}`, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
    let value; try { value = JSON.parse(run.stdout); } catch { value = null; }
    if (!value) return { status: 'warn', check: `usage:${agent}`, detail: run.error?.message || run.stderr.trim() || 'no reading' };
    const status = value.verdict === 'ok' ? 'pass' : value.verdict === 'low' ? 'fail' : 'warn';
    return { status, check: `usage:${agent}`, detail: `${value.window || 'meter'} ${value.used ?? '?'}% (${value.verdict})${value.ageMinutes === null ? '' : `, ${Math.round(value.ageMinutes)}m old`}` };
  });
}

function sentinelCheck(now = Date.now()) {
  const file = path.join(ROOT, 'os-runs', 'sentinel-state.json');
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const checks = Object.entries(state).filter(([, value]) => value && typeof value === 'object' && 'ok' in value);
    const failures = checks.filter(([, value]) => value.ok === false).map(([key]) => key);
    const newest = Math.max(...checks.map(([, value]) => Date.parse(value.at)).filter(Number.isFinite));
    const ageMinutes = Number.isFinite(newest) ? Math.round((now - newest) / 60000) : Infinity;
    const status = failures.length ? 'fail' : ageMinutes > 180 ? 'warn' : 'pass';
    return { status, check: 'sentinel', detail: `${Number.isFinite(ageMinutes) ? `${ageMinutes}m old` : 'no timestamp'}; failures=${failures.join(',') || 'none'}` };
  } catch (error) { return { status: 'warn', check: 'sentinel', detail: `unavailable: ${error.code || error.message}` }; }
}

async function routinesCheck(now = Date.now()) {
  try {
    const data = await jsonFetch('http://localhost:50000/api/routines');
    const rows = data.switches || [];
    const missing = rows.filter(row => !row.pulse?.lastRun?.at);
    const old = rows.filter(row => row.pulse?.lastRun?.at && now - Date.parse(row.pulse.lastRun.at) > 7 * 86400000);
    return { status: missing.length || old.length ? 'warn' : 'pass', check: 'routines', detail: `${rows.length} switches; null=${missing.length}, older than 7d=${old.length}` };
  } catch (error) { return { status: 'fail', check: 'routines', detail: error.message }; }
}

function gitCheck() {
  const run = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  if (run.status !== 0) return { status: 'fail', check: 'git', detail: run.stderr.trim() || 'git status failed' };
  const dirty = run.stdout.split(/\r?\n/).filter(Boolean).filter(line => !line.slice(3).replace(/^"|"$/g, '').replace(/\\/g, '/').startsWith('artifacts/'));
  return { status: dirty.length ? 'warn' : 'pass', check: 'git', detail: `${dirty.length} dirty rows outside artifacts/` };
}

function reapCheck() {
  const file = path.join(ROOT, 'os-runs', 'orca-reap-queue.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const keeps = Array.isArray(data) ? data : Array.isArray(data.keeps) ? data.keeps : Array.isArray(data.queue) ? data.queue.filter(row => row.decision === 'keep' || row.status === 'keep') : [];
    return { status: keeps.length ? 'warn' : 'pass', check: 'orca reap', detail: `${keeps.length} kept workers` };
  } catch (error) { return { status: error.code === 'ENOENT' ? 'pass' : 'warn', check: 'orca reap', detail: error.code === 'ENOENT' ? '0 keeps (no queue file)' : `unreadable: ${error.message}` }; }
}

function backupCheck(now = Date.now()) {
  const ages = REPOS.map(repo => {
    const dir = path.join(BACKUP_ROOT, repo);
    let newest = 0;
    try { for (const name of fs.readdirSync(dir)) if (name.endsWith('.bundle')) newest = Math.max(newest, fs.statSync(path.join(dir, name)).mtimeMs); } catch { }
    return { repo, newest };
  });
  const missing = ages.filter(row => !row.newest).map(row => row.repo);
  const oldestAge = Math.max(...ages.filter(row => row.newest).map(row => (now - row.newest) / 86400000), 0);
  const status = missing.length || oldestAge > 8 ? 'warn' : 'pass';
  return { status, check: 'backups', detail: missing.length ? `missing: ${missing.join(', ')}` : `oldest latest bundle ${oldestAge.toFixed(1)}d` };
}

function portOpen(port) {
  return new Promise(resolve => { const socket = net.createConnection({ host: '127.0.0.1', port }); socket.setTimeout(2000); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('timeout', () => { socket.destroy(); resolve(false); }); socket.once('error', () => resolve(false)); });
}

async function processCheck() {
  if (!(await portOpen(50000))) return { status: 'fail', check: 'port 50000', detail: 'not listening' };
  const command = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match '(^|[\\\\/])server\\.js( |$)' } | Select-Object -ExpandProperty ProcessId";
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', timeout: 10000 });
  const pids = run.stdout.trim().split(/\s+/).filter(Boolean);
  return { status: pids.length ? 'pass' : 'fail', check: 'port 50000', detail: pids.length ? `node server.js running (PID ${pids.join(', ')})` : 'port open but node server.js process not found' };
}

export async function collectChecks() {
  const [health, routines, process] = await Promise.all([healthCheck(), routinesCheck(), processCheck()]);
  return [health, ...usageChecks(), sentinelCheck(), routines, gitCheck(), reapCheck(), backupCheck(), process];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json');
  const unknown = process.argv.slice(2).filter(arg => arg !== '--json');
  if (unknown.length) { console.error('Usage: node tools/hq-doctor.mjs [--json]'); process.exitCode = 2; }
  else {
    const summary = summarizeChecks(await collectChecks());
    if (json) console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...summary }, null, 2));
    else console.log(formatTable(summary.rows));
    process.exitCode = summary.exitCode;
  }
}
