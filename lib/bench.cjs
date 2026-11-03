'use strict';
/* WORKER BENCH (os.html w-bench, GET /api/bench): one lane per worker (Codex, Claude, Copilot, DeepSeek web, OpenCode).
   Now: live Orca agents, Agent HQ live sessions and running deck jobs. Capacity: the tightest window of the same
   /api/stats meters, judged by lib/usage-verdict.cjs (the usage-check gate). Next: the voice build queue head and its
   worker. server.js gathers the inputs (Orca CLI calls time-boxed there); everything here is pure and tested in
   test/bench.test.cjs. No model calls. */
const path = require('path');
const { WINDOWS, UNMETERED, meterVerdict } = require('./usage-verdict.cjs');
const time12 = require('../assets/time12.js');

const WORKERS = [
  { id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude' }, { id: 'copilot', name: 'Copilot' },
  { id: 'deepseek', name: 'DeepSeek web' }, { id: 'opencode', name: 'OpenCode' }
];
const NAME = Object.fromEntries(WORKERS.map(w => [w.id, w.name]));
const OUT_AT = 90, LOW_AT = 80;   // OUT_AT is usage-check's default stop threshold; LOW_AT matches the usage.high event

function readOrcaKeeps(file, io = require('fs')) {
  let value; try { value = JSON.parse(io.readFileSync(file, 'utf8')); } catch (_) { value = {}; }
  const items = Array.isArray(value.items) ? value.items.filter(item => item && typeof item === 'object') : [];
  return { count: items.length, items };
}

/* the worker a piece of text names first ("OpenCode DeepSeek" is OpenCode) */
function workerOf(text) {
  const t = String(text || '').toLowerCase();
  let best = null, at = Infinity;
  for (const w of WORKERS) { const i = t.indexOf(w.id); if (i >= 0 && i < at) { best = w.id; at = i; } }
  return best;
}
const modelWorker = model => /^(gpt|o\d|codex)/i.test(model || '') ? 'codex' : /copilot/i.test(model || '') ? 'copilot' : 'claude';

function until(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + 'm';
  if (m < 1440) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  return Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h';
}
/* "8:05 PM" today, "Sat 8:00 PM" on another day, in tz */
function clock(ms, tz, now = Date.now()) {
  const day = t => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  const hm = time12.time(ms, { tz });
  return day(ms) === day(now) ? hm : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(ms) + ' ' + hm;
}

/* "free", "low (X%)" or "out, back in 43m" from the meter's tightest window */
function capacity(worker, meter, { now = Date.now(), tz = 'America/New_York' } = {}) {
  if (UNMETERED.includes(worker)) return { state: 'none', text: 'no meter' };
  if (!meter) return { state: 'unknown', text: 'no reading' };
  const wins = (meter.windows || []).map(w => meterVerdict(meter, w.label, { threshold: OUT_AT, now })).filter(v => v.used !== null);
  if (!wins.length) return { state: 'unknown', text: 'no reading' };
  const v = wins.reduce((a, b) => b.used > a.used ? b : a);
  const base = { window: v.window, used: v.used, resetsAt: v.resetsAt, stale: v.stale };
  const tail = v.stale ? ' · stale' : '';
  if (v.used >= OUT_AT) return { ...base, state: 'out', text: (v.resetsAt && v.resetsAt > now ? `out, back in ${until(v.resetsAt - now)}` : 'out') + tail,
    back: v.resetsAt && v.resetsAt > now ? clock(v.resetsAt, tz, now) : null };
  if (v.used >= LOW_AT) return { ...base, state: 'low', text: `low (${Math.round(v.used)}%)` + tail };
  return { ...base, state: 'free', text: 'free' + tail };
}

/* "Follow C:\...\specs\hq-x.md" -> "Follow hq-x" */
const shortTask = s => String(s || '').replace(/\s+/g, ' ').replace(/(?:[A-Za-z]:)?[\\/][^\s"'`]*[\\/]([^\\/\s"'`]+)/g, '$1').replace(/\.md\b/gi, '').trim().slice(0, 80);

/* working Orca agents, each with its live terminal handle when Orca lists one */
function orcaNow(ps, terminals) {
  const handles = new Map(((terminals && terminals.terminals) || []).filter(t => t.tabId && t.leafId).map(t => [t.tabId + ':' + t.leafId, t.handle]));
  const out = [];
  for (const wt of (ps && ps.worktrees) || []) for (const a of wt.agents || []) {
    if (a.state !== 'working' && a.mainAgent?.state !== 'working') continue;
    const worker = workerOf(a.agentType);
    if (!worker) continue;
    out.push({ worker, source: 'orca', title: shortTask(a.taskTitle || a.displayName || a.prompt) || wt.displayName || 'agent',
      startedAt: Number(a.stateStartedAt || a.mainAgent?.stateStartedAt) || null, terminal: handles.get(a.paneKey) || null, where: wt.displayName || '' });
  }
  return out;
}
function hqNow(sessions) {
  return (sessions || []).filter(s => ['working', 'waiting', 'permission'].includes(s.status)).map(s => ({
    worker: s.entrypoint === 'codex' ? 'codex' : modelWorker(s.model), source: 'local', title: shortTask(s.title || s.project) || 'session',
    startedAt: Number(s.startedAt) || null, status: s.status }));
}
function jobsNow(jobs) {
  return (jobs || []).filter(j => j.status === 'running').map(j => ({
    worker: j.agent === 'claude-api' || !j.agent ? 'claude' : j.agent, source: 'deck', title: '/' + j.id, startedAt: j.started || null, log: j.jobId + '.log' }));
}
/* one run seen by both Orca and local transcripts starts within a few seconds on both: keep the Orca one (it has the terminal) */
function dedupe(items) {
  const orca = items.filter(i => i.source === 'orca');
  return items.filter(i => i.source !== 'local' || !orca.some(o => o.worker === i.worker && o.startedAt && i.startedAt && Math.abs(o.startedAt - i.startedAt) < 5000));
}

function deepseekLane(tabs, orcaUp) {
  if (!orcaUp) return { available: null, text: 'Orca not running' };
  const n = ((tabs && tabs.tabs) || []).filter(t => { try { return new URL(t.url).hostname === 'chat.deepseek.com'; } catch (_) { return false; } }).length;
  return { available: n > 0, text: n ? `${n} chat tab${n > 1 ? 's' : ''} open` : 'no chat.deepseek.com tab' };
}
function opencodeLane(ps, orcaUp, now = Date.now()) {
  if (!orcaUp) return { available: null, text: 'Orca not running' };
  const runs = [];
  for (const wt of (ps && ps.worktrees) || []) for (const a of wt.agents || []) if (workerOf(a.agentType) === 'opencode') runs.push(a);
  const last = runs.sort((a, b) => (b.stateStartedAt || 0) - (a.stateStartedAt || 0))[0];
  if (!last) return { available: true, text: 'no runs seen' };
  const ago = last.stateStartedAt ? ' ' + until(now - last.stateStartedAt) + ' ago' : '';
  const outcome = last.mainAgent?.outcome || (last.state === 'done' ? 'success' : last.state);
  return { available: outcome !== 'failure', text: outcome === 'failure' ? 'last run failed' + ago : outcome === 'success' ? 'last run ok' + ago : 'last run ' + outcome + ago };
}

/* the spec's "Builder:" / "Workers:" line names its worker; failing that, its opening line ("Paste into a Claude desktop app session") */
function assignedWorker(specText) {
  const lines = String(specText || '').split(/\r?\n/).slice(0, 25);
  const m = lines.join('\n').match(/^\s*(?:Builder|Workers?|Agent)\s*:\s*(.+)$/im);
  if (m) return workerOf(m[1]);
  const first = lines.find(l => l.trim() && !/^\s*[@#]/.test(l));
  return first ? workerOf(first) : null;
}
function nextUp(queue, { specText = () => '', lanes = [], now = Date.now() } = {}) {
  const head = (queue || [])[0] || null;
  const item = (queue || []).find(r => r.status !== 'done');
  if (!item) return { head: head && { name: head.name, status: head.status }, item: null, text: head ? `queue clear (${head.name} ${head.status})` : 'queue empty' };
  const worker = workerOf(item.agent) || assignedWorker(specText(item.path));
  const lane = lanes.find(l => l.id === worker);
  const who = worker ? NAME[worker] : null;
  let text;
  if (item.status === 'building') text = `${item.name} building${who ? ' on ' + who : ''}${item.startedAt ? ' · ' + until(now - item.startedAt) : ''}`;
  else if (!worker) text = `${item.name} next, no worker named`;
  else if (lane && lane.capacity.state === 'out') text = `${item.name} starts when ${who} is back${lane.capacity.back ? ', ~' + lane.capacity.back : ''}`;
  else text = `${item.name} next, for ${who}`;
  return { head: head && { name: head.name, status: head.status }, item: { name: item.name, status: item.status, worker, ...(item.path ? { path: item.path } : {}) }, text };
}

function publicMeters(stats) {
  const byId = new Map((stats.meters || []).map(m => [m.id, m]));
  return ['claude', 'codex', 'copilot'].filter(id => byId.has(id)).map(id => {
    const meter = byId.get(id);
    return { id, name: meter.name || null, plan: meter.plan || null, windows: (meter.windows || []).map(w => ({
      label: w.label, usedPct: Number.isFinite(w.used) ? Math.round(w.used) : null,
      resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, estimated: w.estimated === true, rolledOver: w.rolledOver === true
    })) };
  });
}

function stopList(stats, now) {
  const byId = new Map((stats.meters || []).map(m => [m.id, m]));
  return ['claude', 'codex', 'copilot'].flatMap(worker => {
    const meter = byId.get(worker);
    if (!meter) return [];
    const verdict = meterVerdict(meter, WINDOWS[worker], { threshold: 90, now });
    return verdict.verdict === 'low' ? [{ worker, window: verdict.window, used: verdict.used }] : [];
  });
}

function startState({ orcaUp, next, lanes, stop }) {
  if (!orcaUp) return { available: false, reason: 'Orca not running' };
  if (!next.item) return { available: false, reason: 'nothing queued' };
  if (next.item.status === 'building') return { available: false, reason: 'already building' };
  if (next.item.status === 'done') return { available: false, reason: 'already done' };
  if (next.item.worker && next.item.worker !== 'codex') return { available: false, reason: `next item is for ${NAME[next.item.worker] || next.item.worker}` };
  const stopped = stop.find(s => s.worker === 'codex');
  if (stopped) return { available: false, reason: `Codex ${stopped.window} at ${Math.round(stopped.used)}%` };
  const codex = lanes.find(l => l.id === 'codex');
  if (!codex || codex.state !== 'idle') return { available: false, reason: 'Codex is busy' };
  return { available: true, reason: null };
}

function collect({ stats = {}, hqSessions = [], orca = {}, jobs = [], queue = [], orcaKeeps = { count: 0, items: [] }, specText, now = Date.now(), tz = 'America/New_York' } = {}) {
  const orcaUp = !!orca.ps;
  const items = dedupe([...orcaNow(orca.ps, orca.terminals), ...hqNow(hqSessions), ...jobsNow(jobs)]);
  const meters = new Map((stats.meters || []).map(m => [m.id, m]));
  const lanes = WORKERS.map(w => {
    const nowItems = items.filter(i => i.worker === w.id).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
      .map(i => ({ ...i, minutes: i.startedAt ? Math.max(0, Math.round((now - i.startedAt) / 60000)) : null }));
    const cap = capacity(w.id, meters.get(w.id), { now, tz });
    const avail = w.id === 'deepseek' ? deepseekLane(orca.tabs, orcaUp) : w.id === 'opencode' ? opencodeLane(orca.ps, orcaUp, now) : null;
    const withTerm = nowItems.find(i => i.terminal), withLog = nowItems.find(i => i.log);
    return { id: w.id, name: w.name, now: nowItems, capacity: cap, avail,
      state: nowItems.length ? 'busy' : cap.state === 'out' ? 'out' : avail && avail.available === false ? 'off' : 'idle',
      open: withTerm ? { kind: 'terminal', handle: withTerm.terminal } : withLog ? { kind: 'log', file: withLog.log } : null };
  });
  const next = nextUp(queue, { specText, lanes, now });
  const stop = stopList(stats, now);
  const apiMeter = (stats.meters || []).find(m => m.id === 'claude-api');
  return { fetched: new Date(now).toISOString(), lastRefresh: typeof stats.fetched === 'string' ? stats.fetched : null, timeZone: tz,
    orca: { running: orcaUp, note: orcaUp ? null : (orca.error || 'Orca not running') },
    meters: publicMeters(stats), claudeApi: apiMeter ? { spend: typeof apiMeter.note === 'string' ? apiMeter.note : null,
      consoleLink: 'https://console.anthropic.com/settings/cost' } : null,
    lanes, stop, next, orcaKeeps, start: startState({ orcaUp, next, lanes, stop }) };
}

module.exports = { WORKERS, workerOf, capacity, until, clock, shortTask, orcaNow, hqNow, jobsNow, dedupe, deepseekLane, opencodeLane, assignedWorker,
  nextUp, publicMeters, stopList, startState, readOrcaKeeps, collect };
