#!/usr/bin/env node
// HQ sentinel: deterministic local checks run by Windows Task Scheduler (no model calls).
//   node tools/hq-sentinel.mjs watch  - every 10 min: HQ, engine and native companion watchdog
//   node tools/hq-sentinel.mjs companions - alias of watch for the existing scheduled task
//   node tools/hq-sentinel.mjs boot   - after sign-in: HQ, engine and native companions; starts what's missing
//   node tools/hq-sentinel.mjs pc     - every 2h: C: free space, leaked headless Edge (hqcdp-), RAM, page file
//   node tools/hq-sentinel.mjs usage  - hourly: meter history, projected burn-out before reset
//   node tools/hq-sentinel.mjs missed - enabled desktop and Windows routines that missed an expected fire
//   node tools/hq-sentinel.mjs voice  - advance the approved voice build queue and refresh its ring report
//   node tools/hq-sentinel.mjs accept <checkId> [note] / unaccept <checkId> - stop (or resume) warning about a known pc
//     problem; it warns again if it gets more than 10% worse (lib/sentinel-accepted.cjs, data/sentinel-accepted.json)
//   add --dry-run to report without starting/killing anything or pushing.
// Results: one line in os-runs/sentinel.jsonl per run, events in the HQ event inbox (POST /local/event,
// or lib/hq-events.cjs directly when HQ is down), and an ntfy push (through lib/attention.cjs) only when a check changes state.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const RUNS = path.join(ROOT, 'os-runs');
const STATE = path.join(RUNS, 'sentinel-state.json');
const LOG = path.join(RUNS, 'sentinel.jsonl');
const USAGE_HIST = path.join(RUNS, 'usage-history.jsonl');
const HQ = 'http://localhost:50000';
const PLACES = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'places.cjs'));
const COMPANIONS_ROOT = PLACES.companions;
const COMPANION_SCRIPT = path.join(COMPANIONS_ROOT, 'scripts', 'services.cjs');
const COMPANION_STATE = path.join(COMPANIONS_ROOT, 'config', 'processes.json');
const COMPANION_CRASHES = path.join(COMPANIONS_ROOT, 'logs', 'crashes.jsonl');
const HEARTBEATS = path.join(COMPANIONS_ROOT, 'logs', 'heartbeats');
const COMPANION_BEAT_MS = 10 * 60 * 1000;
const NATIVE_COMPANIONS = [
  { id: 'promptfoo', name: 'promptfoo', port: 50113, healthKey: 'promptfoo' },
  { id: 'qmd', name: 'QMD', port: 50114, healthKey: 'qmd' },
  { id: 'basic-memory', name: 'Basic Memory', port: 50115, healthKey: 'basicMemory' },
];
const mode = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const C_FREE_WARN_GB = 50;
const { missedCron, windowsTaskResult, writeSentinelLog } = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'routine-watchdog.cjs'));
const claudeSchedules = createRequire(import.meta.url)(path.join(ROOT, 'refresh', 'sources', 'claude-code.cjs'));
const voiceSessions = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'voice-sessions.cjs'));
const accepted = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'sentinel-accepted.cjs'));
const attention = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'attention.cjs'));
const restartGuard = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'restart-guard.cjs'));

fs.mkdirSync(RUNS, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson(STATE, {});
if (!state.restarts || typeof state.restarts !== 'object' || Array.isArray(state.restarts)) state.restarts = {};
for (const [target, history] of Object.entries(state.restarts)) state.restarts[target] = restartGuard.shouldRestart(history).history;
if (!state.companionGuards || typeof state.companionGuards !== 'object' || Array.isArray(state.companionGuards)) state.companionGuards = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, ms = 4000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json().catch(() => ({})) : null; } catch { return null; }
}
async function portUp(port) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }); return true; } catch { return false; }
}
function tcpUp(port, ms = 1000) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(ms);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
function ps(script) {
  const enc = Buffer.from(`$ProgressPreference='SilentlyContinue';${script}`, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
}
function startHidden(file) {
  if (DRY) return 'dry-run';
  spawn('wscript.exe', [file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return 'started';
}

function startCompanionService(id) {
  if (DRY) return 'dry-run';
  const child = spawn(process.execPath, [COMPANION_SCRIPT, 'start', id], {
    cwd: COMPANIONS_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return 'started';
}

function persistState() {
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
}

function atomicJson(file, value) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

function companionCrashes(id) {
  try {
    return fs.readFileSync(COMPANION_CRASHES, 'utf8').split(/\r?\n/).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(row => row?.id === id);
  } catch { return []; }
}

function restartDecision(target) {
  const decision = restartGuard.shouldRestart(state.restarts[target]);
  state.restarts[target] = decision.history;
  return decision;
}

function recordRestart(target) {
  state.restarts[target] = restartGuard.record(state.restarts[target]);
  persistState();
}

async function alertRestartLimit(id, summary) {
  if (state[id]?.summary === summary) return;
  await push('HQ restart loop stopped', summary, { source: `sentinel:restart-guard:${id}`, priority: 'high' });
}

async function nativeCompanionStatus() {
  const health = await get(`${HQ}/api/health?fresh=1`);
  const processes = readJson(COMPANION_STATE, {});
  return Promise.all(NATIVE_COMPANIONS.map(async companion => {
    const ok = await portUp(companion.port) && health?.companions?.[companion.healthKey] !== false;
    const record = processes[companion.id] || {};
    if (ok) atomicJson(path.join(HEARTBEATS, `${companion.id}.json`), {
      pid: Number(record.pid) || null, startedAt: record.startedAt || null, lastBeat: new Date().toISOString(), beatMs: COMPANION_BEAT_MS,
    });
    return { ...companion, ok, pid: Number(record.pid) || null, startedAt: record.startedAt || null };
  }));
}

async function checkCompanions() {
  let status = await nativeCompanionStatus();
  let down = status.filter(companion => !companion.ok);
  const wasDown = new Set(down.map(companion => companion.id));
  const actions = new Map();
  const blocked = new Set();
  const now = Date.now();
  for (const companion of status) {
    let guard = state.companionGuards[companion.id];
    for (const crash of companionCrashes(companion.id)) guard = restartGuard.observeCrash(guard, crash, now);
    const flapping = restartGuard.takeFlappingEvent(guard, now);
    guard = flapping.state;
    if (flapping.emit && !DRY) await event({ type: 'companion.flapping', severity: 'error', key: `companion.flapping:${companion.id}:${flapping.crash.at}`,
      summary: `${companion.name} crashed 3 times in an hour; restarts held until healthy`, data: { id: companion.id, lastExit: flapping.crash } });
    if (companion.ok) guard = restartGuard.observeHealthy(guard, { now, startedAt: companion.startedAt });
    state.companionGuards[companion.id] = guard;
  }
  for (const companion of down) {
    const decision = restartGuard.companionDecision(state.companionGuards[companion.id], now);
    if (!decision.allowed) {
      blocked.add(companion.id);
      continue;
    }
    const action = startCompanionService(companion.id);
    actions.set(companion.id, action);
  }
  persistState();
  if (!DRY && actions.size) {
    for (let i = 0; i < 12 && down.some(companion => actions.has(companion.id)); i++) {
      await sleep(5000);
      status = await nativeCompanionStatus();
      down = status.filter(companion => !companion.ok);
    }
  }
  // A restart that worked is still news: log it, since settle() only reports ok flips between runs.
  for (const companion of status) {
    if (DRY || !wasDown.has(companion.id) || !companion.ok) continue;
    await event({ type: 'sentinel.companions.restarted', severity: 'info', key: `sentinel-companion-${companion.id}-restarted-${Date.now()}`,
      summary: `${companion.name} (:${companion.port}) was down; the companion watch restarted it`, data: { port: companion.port } });
  }
  return status.map(companion => ({
    id: `companion-${companion.id}`,
    ok: companion.ok && !blocked.has(companion.id),
    ...(actions.has(companion.id) ? { action: actions.get(companion.id) } : {}),
    summary: blocked.has(companion.id)
      ? `${companion.name} (:${companion.port}) restart delayed by crash backoff or flapping hold`
      : companion.ok
      ? `${companion.name} (:${companion.port}) ${wasDown.has(companion.id) ? 'was down; restarted it' : 'up'}`
      : `${companion.name} (:${companion.port}) down${actions.get(companion.id) === 'started' ? ' after restart attempt' : ''}`,
  }));
}

async function checkHq({ detectHung = true } = {}) {
  let health = await get(`${HQ}/api/health`, 5000);
  if (!health && detectHung && await tcpUp(50000)) {
    await sleep(10000);
    health = await get(`${HQ}/api/health`, 5000);
    if (!health && await tcpUp(50000)) {
      return {
        health: null,
        result: { id: 'hq', ok: false, severity: 'error', summary: 'Agentic HQ (:50000) is not answering health; restart it by hand' },
      };
    }
  }
  if (health) return { health, result: { id: 'hq', ok: true, summary: 'Agentic HQ up' } };

  const decision = restartDecision('hq');
  if (!decision.allowed) {
    const summary = 'Agentic HQ (:50000) restarted 3 times in the last hour; left it down';
    await alertRestartLimit('hq', summary);
    return { health: null, result: { id: 'hq', ok: false, severity: 'error', summary } };
  }
  const action = startHidden(path.join(ROOT, 'tools', 'start-hq.vbs'));
  if (!DRY) {
    recordRestart('hq');
    for (let i = 0; i < 24 && !health; i++) {
      await sleep(5000);
      health = await get(`${HQ}/api/health`, 5000);
    }
  }
  if (health && !DRY) await event({ type: 'sentinel.hq.restarted', severity: 'info', key: `sentinel-hq-restarted-${Date.now()}`,
    summary: 'Agentic HQ (:50000) was down; the watchdog restarted it', data: { port: 50000 } });
  return {
    health,
    result: { id: 'hq', ok: !!health, severity: 'error', action,
      summary: health ? 'Agentic HQ was down; restarted it' : 'Agentic HQ (:50000) is down and did not start' },
  };
}

async function watch() {
  const hq = await checkHq();
  const engine = { id: 'engine', ok: !!hq.health?.engine,
    summary: hq.health ? (hq.health.engine ? 'Second Brain engine up' : 'Second Brain engine (:50201) is down; restart HQ to bring it back')
      : 'Second Brain engine status unavailable because Agentic HQ is down' };
  return [hq.result, engine, ...await checkCompanions()];
}

const companions = watch;

async function event(ev) {
  const body = JSON.stringify({ source: 'hq-sentinel', ...ev });
  try {
    const r = await fetch(`${HQ}/local/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(4000) });
    if (r.ok) return;
  } catch { }
  try { createRequire(import.meta.url)(path.join(ROOT, 'lib', 'hq-events.cjs')).append({ source: 'hq-sentinel', ...ev }); } catch { }
}
// Every push goes through the attention budget (lib/attention.cjs): 3 a day, the rest held for the 20:00 digest.
async function push(title, text, { source = `sentinel:${mode}`, priority = 'normal' } = {}) {
  if (DRY) return;
  try { await attention.notify({ source, title, text, priority, click: HQ }); } catch { }
}
// HQ down or a routine failing is urgent; recoveries only go to the digest.
const pushPriority = changes => changes.some(c => !c.ok && (c.severity === 'error' || c.eventType === 'routine.failed')) ? 'urgent'
  : changes.every(c => c.ok) ? 'low' : 'normal';

// A check result: {id, ok, summary}. Events and pushes fire only when ok flips (or on first failure).
async function settle(results, { modeName = mode, title } = {}) {
  const changes = [];
  for (const r of results) {
    const prev = state[r.id];
    const changed = !prev || prev.ok !== r.ok;
    state[r.id] = { ok: r.ok, summary: r.summary, at: new Date().toISOString(), data: r.data || null, ...(r.accepted ? { accepted: true } : {}) };
    if (!changed || r.accepted) continue; // accepting a known problem is not news
    if (!prev && r.ok) continue; // first sighting of a healthy check: nothing to say
    changes.push(r);
    if (!DRY) await event({ type: r.eventType || (r.ok ? `sentinel.${modeName}.recovered` : `sentinel.${modeName}.problem`), severity: r.ok ? 'info' : (r.severity || 'warn'),
      key: r.eventKey || `sentinel-${r.id}-${r.ok}`, summary: r.summary.slice(0, 480), data: r.data || {} });
  }
  if (changes.length) await push(typeof title === 'function' ? title(changes) : (title || `HQ ${modeName} check`), changes.map(c => `${c.ok ? 'OK' : '!!'} ${c.summary}`).join('\n'),
    { source: `sentinel:${modeName}`, priority: pushPriority(changes) });
  if (!DRY) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
  const line = { ts: new Date().toISOString(), mode: modeName, dryRun: DRY, ok: results.every(r => r.ok), changes: changes.length,
    results: results.map(({ id, ok, summary, action, data }) => ({ id, ok, summary, action, data })) };
  if (!DRY) writeSentinelLog(LOG, line);
  return line;
}

async function boot() {
  const out = [];
  // Agentic HQ server + engine
  const hq = await checkHq({ detectHung: false });
  const health = hq.health;
  out.push(hq.result);
  out.push({ id: 'engine', ok: !!health?.engine, summary: health?.engine ? 'Second Brain engine up' : 'Second Brain engine (:50201) not running' });
  // Native companions only; Docker companions (:50110-50112) are managed separately.
  const native = await checkCompanions();
  const down = native.filter(companion => !companion.ok);
  out.push({ id: 'companions', ok: !down.length, action: native.find(companion => companion.action)?.action,
    summary: down.length ? `Native companions down after restart attempt: ${down.map(companion => companion.summary).join(', ')}` : 'Companions up' });
  return out;
}

async function pc() {
  const out = [];
  const raw = ps(String.raw`
$d = Get-PSDrive C; $os = Get-CimInstance Win32_OperatingSystem
$leak = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*hqcdp-*' })
$pf = (Get-CimInstance Win32_PageFileUsage | Measure-Object AllocatedBaseSize -Sum).Sum
[pscustomobject]@{ freeGB=[math]::Round($d.Free/1GB,1); ramFreeGB=[math]::Round($os.FreePhysicalMemory/1MB,1); ramGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1); leaked=$leak.Count; leakMB=[math]::Round((($leak | Measure-Object WorkingSetSize -Sum).Sum)/1MB); pagefileMB=$pf } | ConvertTo-Json -Compress`);
  const m = JSON.parse(raw);
  out.push({ id: 'disk-c', ok: m.freeGB >= C_FREE_WARN_GB, data: { value: m.freeGB, worse: 'lower' }, summary: `C: ${m.freeGB} GB free${m.freeGB < C_FREE_WARN_GB ? ` (under ${C_FREE_WARN_GB} GB: run a disk cleanup pass)` : ''}` });
  if (m.leaked > 0) {
    // Leaked headless Edge from HQ CDP scripts is never wanted (memory note headless-edge-leak); killing it is the safe fix.
    let action = 'dry-run';
    if (!DRY) { ps("Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*hqcdp-*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"); action = 'killed'; }
    out.push({ id: 'edge-leak', ok: action === 'killed', action, summary: `${m.leaked} leaked headless Edge processes (${m.leakMB} MB)${action === 'killed' ? ' were killed' : ''}` });
  } else out.push({ id: 'edge-leak', ok: true, summary: 'No leaked headless Edge' });
  out.push({ id: 'ram', ok: m.ramFreeGB >= 3, data: { value: m.ramFreeGB, worse: 'lower' }, summary: `RAM ${m.ramFreeGB} of ${m.ramGB} GB free` });
  out.push({ id: 'pagefile', ok: !m.pagefileMB || m.pagefileMB <= 32768, data: { value: m.pagefileMB || 0, worse: 'higher' }, summary: `Page file ${Math.round((m.pagefileMB || 0) / 1024)} GB${m.pagefileMB > 32768 ? ' (over 32 GB: reboot, or set a fixed 16 GB)' : ''}` });
  return accepted.apply(out);
}

// node tools/hq-sentinel.mjs accept <checkId> [note] | unaccept <checkId>: uses the check's last measured value from sentinel-state.json.
async function acceptCmd() {
  const [, , cmd, id, ...note] = process.argv.filter(a => a !== '--dry-run');
  if (!id) throw new Error(`usage: node tools/hq-sentinel.mjs ${cmd} <checkId>${cmd === 'accept' ? ' [note]' : ''}`);
  if (cmd === 'accept') {
    const entry = accepted.accept(id, state[id], note.join(' '));
    await event({ type: 'sentinel.pc.accepted', severity: 'info', key: `sentinel-${id}-accepted`, summary: `${id} accepted at ${entry.value}${entry.note ? `: ${entry.note}` : ''}`, data: { id, ...entry } });
    return { ok: true, accepted: id, ...entry };
  }
  accepted.unaccept(id);
  await event({ type: 'sentinel.pc.unaccepted', severity: 'info', key: `sentinel-${id}-unaccepted-${Date.now()}`, summary: `${id} no longer accepted; it warns again on the next pc run`, data: { id } });
  return { ok: true, unaccepted: id };
}

async function usage() {
  const stats = await get(`${HQ}/api/stats`);
  if (!stats?.meters) return [{ id: 'usage-read', ok: false, summary: 'Could not read /api/stats (HQ down?)' }];
  const now = Date.now(), out = [], snap = { ts: new Date(now).toISOString(), meters: {} };
  for (const m of stats.meters) {
    if (!Array.isArray(m.windows)) continue;
    snap.meters[m.id] = m.windows.map(w => ({ label: w.label, used: w.used, resetsAt: w.resetsAt }));
    for (const w of m.windows) {
      if (!Number.isFinite(w.used) || !Number.isFinite(w.resetsAt) || w.label === 'inline') continue;
      const id = `burn-${m.id}-${w.label}`;
      const runsOut = Number.isFinite(w.fullAt) && w.fullAt < w.resetsAt && w.used < 100;
      const mins = runsOut ? Math.max(0, Math.round((w.fullAt - now) / 60000)) : null;
      // >= 90% is already raised by the server's usage.low event; just describe it here.
      if (w.used >= 90 && !runsOut) { out.push({ id, ok: true, summary: `${m.name} ${w.label} at ${Math.round(w.used)}%: nearly used up until it resets` }); continue; }
      out.push({ id, ok: !runsOut || mins > 180, summary: runsOut ? `${m.name} ${w.label} at ${Math.round(w.used)}%, on pace to run out in ~${mins} min, before its reset${m.id === 'codex' ? ': move heavy work to DeepSeek web or Claude' : m.id === 'claude' ? ': move heavy work to Codex or DeepSeek web' : ''}` : `${m.name} ${w.label} ${Math.round(w.used)}%, fine until reset` });
    }
  }
  if (!DRY) fs.appendFileSync(USAGE_HIST, JSON.stringify(snap) + '\n');
  return out;
}

const slug = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const iso = value => value ? new Date(value).toISOString() : null;
const wallTime = start => { const match = /T(\d\d):(\d\d)/.exec(String(start || '')); return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null; };
const windowsDow = mask => [[1, 0], [2, 1], [4, 2], [8, 3], [16, 4], [32, 5], [64, 6]].filter(([bit]) => Number(mask) & bit).map(([, day]) => day);

function windowsTasks() {
  const raw = ps(String.raw`
$rows = @(Get-ScheduledTask -TaskName 'Agentic HQ *' | ForEach-Object {
  $info = Get-ScheduledTaskInfo -TaskName $_.TaskName
  [pscustomobject]@{
    name=$_.TaskName
    last=if($info.LastRunTime){$info.LastRunTime.ToString('o')}else{$null}
    result=$info.LastTaskResult
    triggers=@($_.Triggers | ForEach-Object { [pscustomobject]@{
      class=$_.CimClass.CimClassName; start=$_.StartBoundary; days=$_.DaysOfWeek
      weeks=$_.WeeksInterval; daysInterval=$_.DaysInterval
      repetitionInterval=$_.Repetition.Interval; repetitionDuration=$_.Repetition.Duration
    }})
  }
})
$rows | ConvertTo-Json -Depth 6 -Compress`);
  const parsed = JSON.parse(raw || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

function intervalMissed(trigger, lastRunAt, now, graceMs) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(String(trigger.repetitionInterval || ''));
  const start = Date.parse(trigger.start || ''), interval = match ? (Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 60000 : 0;
  const cutoff = now - graceMs;
  if (!Number.isFinite(start) || !interval || start > cutoff) return { missed: 0, lastExpected: null, lastRunAt: Date.parse(lastRunAt || '') || null };
  const lastExpected = start + Math.floor((cutoff - start) / interval) * interval;
  const last = Date.parse(lastRunAt || '') || null;
  if (last && last >= lastExpected) return { missed: 0, lastExpected, lastRunAt: last };
  const anchor = Math.max(last || start - 1, start - 1);
  return { missed: Math.max(1, Math.floor((lastExpected - anchor) / interval)), lastExpected, lastRunAt: last };
}

async function missed() {
  const now = Date.now(), graceMs = 2 * 3600000, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
  const out = [];
  const group = claudeSchedules.scheduledTasks();
  for (const routine of group?.routines || []) {
    if (routine.status !== 'active' || !routine.cron) continue;
    const since = Math.max(Number(routine.createdAt) || 0, Date.parse(routine.scanFloor || '') || 0) || null;
    const check = missedCron({ cron: routine.cron, lastRunAt: routine.lastRunAt, createdAt: since, now, graceMs, timeZone, respectCreatedAt: true });
    const task = routine.taskId || String(routine.id).replace(/^rt:task-/, '');
    const data = { id: task, name: routine.name, source: 'desktop', missed: check.missed, lastRunAt: routine.lastRunAt || null, lastExpected: iso(check.lastExpected) };
    out.push({ id: `routine-missed:${task}`, ok: check.missed === 0, severity: 'warn', data,
      eventType: check.missed ? 'routine.missed' : 'routine.recovered', eventKey: check.missed ? `routine.missed:${task}` : `routine.recovered:${task}`,
      summary: check.missed ? `${task} missed ${check.missed} fire${check.missed === 1 ? '' : 's'}; open the Claude desktop app and check Scheduled` : `${task} is running on schedule` });
  }

  for (const task of windowsTasks()) {
    const id = `windows-${slug(task.name)}`, result = windowsTaskResult(task.result), never = result.never;
    let check = { missed: 0, lastExpected: null, lastRunAt: Date.parse(task.last || '') || null };
    for (const trigger of task.triggers || []) {
      const time = wallTime(trigger.start);
      let current;
      if (trigger.class === 'MSFT_TaskDailyTrigger' && time) current = missedCron({ cron: `${time.minute} ${time.hour} * * *`, lastRunAt: never ? null : task.last, createdAt: trigger.start, now, graceMs, timeZone, respectCreatedAt: true });
      else if (trigger.class === 'MSFT_TaskWeeklyTrigger' && time) {
        const days = windowsDow(trigger.days); if (days.length) current = missedCron({ cron: `${time.minute} ${time.hour} * * ${days.join(',')}`, lastRunAt: never ? null : task.last, createdAt: trigger.start, now, graceMs, timeZone, respectCreatedAt: true });
      } else if (trigger.class === 'MSFT_TaskTimeTrigger') current = intervalMissed(trigger, never ? null : task.last, now, graceMs);
      if (current && (!check.lastExpected || current.lastExpected > check.lastExpected)) check = current;
    }
    const failed = result.failed;
    const bad = failed || check.missed > 0;
    const data = { id, name: task.name, source: 'windows', missed: check.missed, lastRunAt: never ? null : task.last, lastExpected: iso(check.lastExpected), lastResult: Number(task.result) };
    out.push({ id: `routine-missed:${id}`, ok: !bad, severity: failed ? 'error' : 'warn', data,
      eventType: bad ? (failed ? 'routine.failed' : 'routine.missed') : 'routine.recovered', eventKey: bad ? `${failed ? 'routine.failed' : 'routine.missed'}:${id}` : `routine.recovered:${id}`,
      summary: failed ? `${task.name} failed with Last Result ${task.result}; open Task Scheduler` : check.missed ? `${task.name} missed ${check.missed} fire${check.missed === 1 ? '' : 's'}; open Task Scheduler` : `${task.name} is running on schedule` });
  }
  return out;
}

// Once per Windows boot: one push saying the HQ routines came back on their own (or which didn't), so nobody has to remember to check.
const AFTER_RESTART = ['Agentic HQ Start', 'Agentic HQ Watchdog', 'Agentic HQ Orca Cleanup', 'Agentic HQ Usage Guard'];
async function afterRestart() {
  const boot = Date.parse(ps(`(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')`) || '');
  if (!Number.isFinite(boot) || state.restartConfirmedFor === boot) return null;
  if (state.restartConfirmedFor === undefined) { state.restartConfirmedFor = boot; persistState(); return null; } // first run: start from the next boot
  if (Date.now() - boot < 40 * 60000) return null;
  const tasks = new Map(windowsTasks().map(task => [task.name, task]));
  const ran = name => { const task = tasks.get(name); return !!task && !windowsTaskResult(task.result).never && Date.parse(task.last || '') >= boot; };
  const missing = AFTER_RESTART.filter(name => !ran(name));
  if (missing.length && Date.now() - boot < 3 * 3600000) return { ok: false, waiting: missing };
  const short = names => names.map(name => name.replace('Agentic HQ ', '')).join(', ');
  const ok = !missing.length;
  const summary = ok ? `After the restart, ${short(AFTER_RESTART)} all ran on their own.` : `After the restart, ${short(missing)} never ran; open Task Scheduler.`;
  if (!DRY) await event({ type: ok ? 'sentinel.restart.confirmed' : 'sentinel.restart.missing', severity: ok ? 'info' : 'warn', key: `sentinel.restart:${boot}`, summary });
  if (!DRY) await push(ok ? 'HQ is back after restart' : 'HQ routines missing after restart', summary, { source: 'sentinel:restart', priority: ok ? 'normal' : 'high' });
  state.restartConfirmedFor = boot;
  persistState();
  return { ok, summary };
}

async function voice() {
  const specsDir = process.env.HQ_VOICE_SPECS || path.join(PLACES.workbench, 'handoffs', 'specs');
  const result = voiceSessions.loadVoiceState({ root: ROOT, specsDir, syncQueue: true, advanceQueue: !DRY });
  if (!result.available) return { ts: new Date().toISOString(), mode: 'voice', dryRun: DRY, ok: true, available: false, advanced: 0 };
  if (!DRY) voiceSessions.writeVoiceReport(result);
  if (!DRY) for (const item of result.advanced) await event({ type: 'voice.spec.done', severity: 'info', key: `voice.spec.done:${slug(item.name)}`,
    summary: `Voice queue completed ${item.name}`, data: { spec: item.name, commit: item.commit?.hash || null } });
  if (result.advanced.length) {
    const title = result.advanced.length === 1 ? `Built: ${result.advanced[0].name}` : `${result.advanced.length} voice specs built`;
    await push(title, `${result.advanced.length} built · ${result.queueHead ? '1 next' : 'queue clear'}`, { source: 'sentinel:voice' });
  }
  return { ts: new Date().toISOString(), mode: 'voice', dryRun: DRY, ok: true, available: true, advanced: result.advanced.length,
    queueHead: result.queueHead?.name || null, report: path.basename(result.reportFile) };
}

const checks = { boot, watch, companions, pc, usage, missed, voice };
if (!checks[mode] && mode !== 'accept' && mode !== 'unaccept') { console.error('usage: node tools/hq-sentinel.mjs <boot|watch|companions|pc|usage|missed|voice> [--dry-run] | accept <checkId> [note] | unaccept <checkId>'); process.exit(2); }
if (mode === 'accept' || mode === 'unaccept') {
  try { console.log(JSON.stringify(await acceptCmd(), null, 1)); } catch (e) { console.error(e.message); process.exitCode = 2; }
} else try {
  const missedOptions = { modeName: 'missed', title: changes => {
    const bad = changes.filter(change => !change.ok).length, good = changes.length - bad;
    return bad ? `${bad} routine${bad === 1 ? '' : 's'} missed${good ? ` · ${good} recovered` : ''}` : `${good} routine${good === 1 ? '' : 's'} recovered`;
  } };
  const line = mode === 'pc'
    ? { pc: await settle(await pc(), { modeName: 'pc' }), missed: await settle(await missed(), missedOptions), voice: await voice(), restart: await afterRestart() }
    : mode === 'voice' ? await voice() : await settle(await checks[mode](), mode === 'missed' ? missedOptions : {});
  console.log(JSON.stringify(line, null, 1));
  process.exitCode = (mode === 'pc' ? line.pc.ok && line.missed.ok && line.voice.ok : line.ok) ? 0 : 1; // not process.exit(): it trips a libuv assert on Windows while fetch sockets close
} catch (e) {
  await event({ type: `sentinel.${mode}.error`, severity: 'error', key: `sentinel-${mode}-crash`, summary: String(e.message || e).slice(0, 400) });
  console.error(e); process.exitCode = 3;
}
