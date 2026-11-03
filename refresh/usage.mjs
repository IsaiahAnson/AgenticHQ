// Usage for the Skills, Applications and Routines tabs. Reads files on this machine only and
// calls no model, so a refresh costs no tokens. Three sources, all optional:
//  1. snapshots/usage-log.jsonl - one line per skill run, routine run or app call, written by any
//     agent (shape in USAGE.md)
//  2. data/app-opens.jsonl - written by the OS each time you open a Micro Apps tile
//  3. your agent's own session logs, when a reader for them exists (refresh/sources/)
// Anything no source measures shows as "not measured". Nothing is estimated or made up.
// Writes data/arms-usage.js (for the pages) and data/arms-usage.json.
// Run: node refresh/usage.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)), KIT = path.resolve(HERE, '..');
const claudeCode = require('./sources/claude-code.cjs');
const { allRoutines, readerOn } = require('./lib/sources.cjs');
const apps = require('./lib/apps.cjs');
const DAY = 864e5, now = Date.now(), SHORT = 7, LONG = 30, WINDOWS = [7, 30, 60, 90], cutoff = now - 90 * DAY, t0 = Date.now();
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const readLines = p => { try { return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const dayCut = d => dayOf(now - (d - 1) * DAY);
const inWin = (t, d) => t >= now - d * DAY;
const sumDays = (days, d) => Object.entries(days).filter(([k]) => k >= dayCut(d)).reduce((a, [, n]) => a + n, 0);
const lastDay = days => Object.keys(days).filter(k => days[k] > 0).sort().pop() || null;
const norm = s => String(s || '').toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9]/g, '');

// ---------- the sources ----------
const log = readLines(path.join(KIT, 'snapshots', 'usage-log.jsonl')).map(e => ({ ...e, t: Date.parse(e.at || e.time || e.t) })).filter(e => e.t >= cutoff && e.t <= now + DAY);
const opens = readLines(path.join(KIT, 'data', 'app-opens.jsonl')).map(e => ({ ...e, t: Date.parse(e.at) })).filter(e => e.t >= cutoff);
let sessions = null;
// os-config.json "readers": { "claudeCode": false } turns this reader off (no folder of that agent is read)
if (readerOn('claudeCode')) { try { sessions = claudeCode.sessionUsage(90); } catch (e) { console.error('session logs:', e.message); } }
const sources = [];
if (log.length) sources.push('usage log (' + log.length + ' entries)');
if (sessions) sources.push('agent session logs (' + sessions.files + ' files)');
sources.push('OS launcher opens (' + opens.length + ')');

// ---------- skills ----------
const skillList = readJSON(path.join(KIT, 'data', 'skills.json'), []);
const skillRows = new Map(), skillByNorm = new Map();
const rowFor = (name, kind, desc) => {
  if (!skillRows.has(name)) { const row = { name: '/' + name, id: name, kind: kind || 'skill', desc: desc || '', last: 0 }; for (const d of WINDOWS) { row['runs'+d]=0; row['tok'+d]=0; row['cost'+d]=0; row['subagents'+d]=0; } skillRows.set(name, row); skillByNorm.set(norm(name), name); }
  return skillRows.get(name);
};
for (const s of skillList) rowFor(s.name, s.kind, s.desc);
const addRun = (row, t, tok, cost, sub) => {
  for (const d of WINDOWS) if (inWin(t,d)) { row['runs'+d]++; row['tok'+d] += tok || 0; row['cost'+d] += cost || 0; row['subagents'+d] += sub || 0; }
  if (t > row.last) row.last = t;
};
let skillsMeasured = false;
if (sessions) {
  skillsMeasured = true;
  for (const r of sessions.skillRuns) {
    const name = skillByNorm.get(norm(r.name));
    if (!name) continue;                       // a built-in command, or a skill outside your skill folders
    if (r.cmd && skillList.find(s => s.name === name && s.kind === 'skill')) continue;   // a typed skill also logs its load line
    addRun(rowFor(name), r.t, r.tok, r.cost, r.sub);
  }
}
for (const e of log.filter(e => e.kind === 'skill')) {
  skillsMeasured = true;
  const name = skillByNorm.get(norm(e.name)) || String(e.name || '').replace(/^\/+/, '');
  if (name) addRun(rowFor(name, 'skill'), e.t, +e.tokens || 0, +e.cost || 0, 0);
}
const skills = [...skillRows.values()].map(r => { const x={...r,last:r.last?new Date(r.last).toISOString():null}; for(const d of WINDOWS){x['tok'+d]=Math.round(r['tok'+d]);x['cost'+d]=+r['cost'+d].toFixed(4)} return x });

// ---------- routines ----------
const all = allRoutines();
const byNorm = new Map(); for (const r of all.routines) { byNorm.set(norm(r.id), r.id); byNorm.set(norm(r.name), r.id); }
const runsBy = new Map();
const addRoutineRun = (id, t, tok, cost) => { const l = runsBy.get(id) || []; l.push({ t, tok: tok || 0, cost: cost || 0 }); runsBy.set(id, l); };
let routinesMeasured = false;
if (sessions && sessions.routineRuns.length) { routinesMeasured = true; for (const x of sessions.routineRuns) addRoutineRun(x.routine, x.t, x.tok, x.cost); }
for (const e of log.filter(e => e.kind === 'routine')) { routinesMeasured = true; const id = byNorm.get(norm(e.name)) || byNorm.get(norm(e.id)); if (id) addRoutineRun(id, e.t, +e.tokens || 0, +e.cost || 0); }
const routines = {};
for (const [id, list] of runsBy) {
  const w7 = list.filter(r => inWin(r.t, SHORT)), w30=list.filter(r=>inWin(r.t,LONG)), sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
  routines[id] = { runs7: w7.length, tok7: Math.round(sum(w7, 'tok')), cost7: +sum(w7, 'cost').toFixed(4), runs30: w30.length, tok30: Math.round(sum(w30, 'tok')), cost30: +sum(w30, 'cost').toFixed(4), perRunTok: w30.length?Math.round(sum(w30, 'tok') / w30.length):0, perRunCost: w30.length?+(sum(w30, 'cost') / w30.length).toFixed(4):0, last: new Date(Math.max(...list.map(r => r.t))).toISOString() };
}

// ---------- applications (your connections) and local apps (the Micro Apps tiles) ----------
const appCfg = readJSON(path.join(KIT, 'config', 'apps.json'), { apps: [] }).apps || [];
const appRows = appCfg.map(a => ({ id: a.id, label: a.label || a.id, kind: a.kind || 'mcp', group: ['cli', 'api', 'app'].includes(a.kind) ? 'tool' : 'connector', desc: a.desc || '', status: a.status || '', iconSlug: a.iconSlug || '', days: {}, match: a }));
let appsMeasured = false;
const bump = (row, days) => { for (const [d, n] of Object.entries(days)) row.days[d] = (row.days[d] || 0) + n; };
if (sessions) {
  appsMeasured = true;
  for (const [k, days] of Object.entries(sessions.toolDays)) {
    if (k.startsWith('m:')) { const server = k.slice(2); for (const row of appRows) { const m = row.match; if ((m.mcp && norm(m.mcp) === norm(server)) || (!m.mcp && norm(row.id.replace(/^app:/, '')) === norm(server))) bump(row, days); } }
    if (k.startsWith('w:')) { const word = k.slice(2); for (const row of appRows) if (row.match.command && String(row.match.command).toLowerCase() === word) bump(row, days); }
  }
}
for (const e of log.filter(e => e.kind === 'app')) { appsMeasured = true; const row = appRows.find(r => norm(r.id) === norm(e.name) || norm(r.id.replace(/^app:/, '')) === norm(e.name) || norm(r.label) === norm(e.name)); if (row) { const d = dayOf(e.t); row.days[d] = (row.days[d] || 0) + (+e.calls || 1); } }
const appsOut = appRows.map(a => ({ id: a.id, label: a.label, kind: a.kind, group: a.group, desc: a.desc, status: a.status, iconSlug: a.iconSlug, ...Object.fromEntries(WINDOWS.map(d=>['calls'+d,sumDays(a.days,d)])), last: lastDay(a.days) }));
const local = apps.list().map(a => {
  const days = {}, agentDays = {};
  for (const o of opens) if (o.app === a.id) { const d = dayOf(o.t); days[d] = (days[d] || 0) + 1; }
  if (sessions && a.port) { const dd = sessions.toolDays['p:' + a.port] || {}; for (const [d, n] of Object.entries(dd)) agentDays[d] = (agentDays[d] || 0) + n; }
  return { id: 'local:' + a.id, label: a.name, kind: 'local', group: 'rubric', desc: a.desc || '', port: a.port || null, status: '', ...Object.fromEntries(WINDOWS.flatMap(d=>[['visits'+d,sumDays(days,d)],['agentCalls'+d,sessions?sumDays(agentDays,d):null]])), last: lastDay(days) };
});

// ---------- totals ----------
const totals = {};
for (const d of WINDOWS) {
  let tok = 0, cost = 0;
  if (sessions) for (const [k, v] of Object.entries(sessions.dayTotals)) if (k >= dayCut(d)) { tok += v.tok; cost += v.cost; }
  for (const e of log) if (inWin(e.t, d) && e.kind !== 'app') { tok += +e.tokens || 0; cost += +e.cost || 0; }
  totals[d] = { tok: Math.round(tok), cost: +cost.toFixed(2) };
}
const out = {
  generatedAt: new Date().toISOString(), windows: { short: SHORT, long: LONG, available: WINDOWS }, sources,
  measured: { skills: skillsMeasured, routines: routinesMeasured, apps: appsMeasured, localApps: true, tokens: !!sessions || log.some(e => e.tokens) },
  scan: { sessionFiles: sessions ? sessions.files : 0, logEntries: log.length, opens: opens.length, ms: Date.now() - t0 },
  rates: { note: 'API $ is what the measured tokens would cost at standard API rates, not your subscription bill.' },
  method: {
    skill: 'Skill runs come from your usage log and, when your agent keeps session logs this OS can read, from those logs. Anything not measured says so.',
    routine: 'A routine run comes from the same sources. Routines with no measured runs show "not measured".',
    tokens: 'Tokens are counted as your agent logged them. Each model call counts once.',
    apps: 'Your connections: calls in your usage log or session logs. Local apps: opens through the OS launcher tiles.',
  },
  totals, skills, routines, apps: appsOut, rubric: local,
};
/* local add-ons (lib/addons.cjs "usage") add their own fields from the figures above; demo mode runs none */
for (const file of require('../lib/addons.cjs').usageFiles(KIT)) {
  try { Object.assign(out, await (await import(pathToFileURL(file).href)).default({ kit: KIT, out, now, windows: WINDOWS, cutoff })); }
  catch (e) { console.error('add-on usage (' + path.relative(KIT, file) + '):', e.message); }
}
/* local addition: the model each routine last ran on, for the Routines widget badges */
if (sessions && sessions.routineRuns) { const last = {}; for (const x of sessions.routineRuns) if (x.model && (!last[x.routine] || x.t > last[x.routine].t)) last[x.routine] = { model: x.model, t: x.t }; fs.writeFileSync(path.join(KIT, 'data', 'routine-models.json'), JSON.stringify(last, null, 1)); }
fs.writeFileSync(path.join(KIT, 'data', 'arms-usage.json'), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(KIT, 'data', 'arms-usage.js'), 'window.ARMS_USAGE=' + JSON.stringify(out) + ';\n');
console.log(JSON.stringify({ sources, skills: skills.length, measured: out.measured, ms: Date.now() - t0 }));
