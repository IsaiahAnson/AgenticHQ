'use strict';
/* AUTOMATION PULSE (os.html w-pulse, GET /api/pulse): one row per automation answering two questions.
   Is it running? A 7-day strip, today on the right: ok = ran ok, fail = last run that day failed,
   miss = expected but no run, none = not scheduled, unknown = expected before any run history was kept.
   Is it earning its keep? Of the reports it wrote to artifacts/ in the last 14 days, how many were kept
   (opened, per data/artifact-opens.jsonl) vs trashed (artifacts/_trash/).
   Pure functions first (tested in test/pulse.test.cjs), then collect() reads the files. No model calls. */
const fs = require('fs');
const path = require('path');
const { firesOn } = require('../refresh/lib/routines.cjs');

const DAY = 864e5;
const GRACE_MIN = 30;                       // a fire counts as expected 30 min after its time
const OK_RESULTS = new Set([0, 267009]);    // Task Scheduler: 0 = success, 267009 = still running
const NEVER_RAN = 267011;
const KEPT_DAYS = 14, STRIP_DAYS = 7, NOISY_RUN = 5;
const RETIRED_INTO = {
  'deps-check': 'Weekly Dev Health', 'projects-recap': 'Weekly Dev Health', 'prompt-evals': 'Weekly Dev Health',
  'gh-inbox': 'job command center', 'job-funnel-review': 'job command center', 'skill-review': 'Gotcha Proposals'
};
/* jobs the server runs that were never deck cards (Review bar, AI Radar builds, save-format): live, not retired */
const INTERNAL_JOBS = new Set(['apply-comments', 'radar-implement', 'save-format']);

/* ---------- days ---------- */
function dayOf(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
function minutesOf(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return +p.hour * 60 + +p.minute;
}
const addDays = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
function lastDays(now, tz, n = STRIP_DAYS) {
  const today = dayOf(now, tz);
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

/* day => was a run expected that day? Today only counts fires already GRACE_MIN old. */
function cronExpected(cron, tz, now) {
  if (!cron) return () => false;
  const today = dayOf(now, tz), nowMin = minutesOf(now, tz);
  return day => {
    const times = firesOn({ status: 'active', cron }, day, tz);
    return day === today ? times.some(m => m + GRACE_MIN <= nowMin) : times.length > 0;
  };
}

/* runs: [{ ts (ms), ok }]. since: the first moment run history exists for this row (ms or null). */
function dayStrip({ days, runs = [], expected = () => false, since = null, tz }) {
  const byDay = new Map();
  for (const r of [...runs].sort((a, b) => a.ts - b.ts)) byDay.set(dayOf(r.ts, tz), r);
  const sinceDay = since ? dayOf(since, tz) : null;
  return days.map(day => {
    const last = byDay.get(day);
    if (last) return last.ok ? 'ok' : 'fail';
    if (!expected(day)) return 'none';
    return sinceDay && day < sinceDay ? 'unknown' : 'miss';
  });
}

/* reports: [{ file, at (ms), trashed }]. Before open tracking started, a report still on the ring counts as kept;
   after it, a report has to have been opened. null when there were no reports in the window. */
function keptRatio(reports, opens = [], { now = Date.now(), days = KEPT_DAYS } = {}) {
  const recent = reports.filter(r => r.at >= now - days * DAY);
  if (!recent.length) return null;
  const opened = new Set(opens.map(o => o.file));
  const since = opens.length ? Math.min(...opens.map(o => o.ts)) : null;
  const kept = recent.filter(r => !r.trashed && (opened.has(r.file) || since === null || r.at < since)).length;
  return { kept, total: recent.length, trashed: recent.filter(r => r.trashed).length, opened: recent.filter(r => opened.has(r.file)).length };
}

/* the last NOISY_RUN reports were all trashed: a candidate to cut */
function isNoisy(reports) {
  const last = [...reports].sort((a, b) => b.at - a.at).slice(0, NOISY_RUN);
  return last.length === NOISY_RUN && last.every(r => r.trashed);
}

/* problems (today red or gray) first, then the lowest kept ratio, then the rest by name */
function sortRows(rows) {
  const today = r => r.dots[r.dots.length - 1];
  const problem = r => ['fail', 'miss'].includes(today(r)) ? 0 : 1;
  const ratio = r => r.useful ? r.useful.kept / r.useful.total : 2;
  return [...rows].sort((a, b) => problem(a) - problem(b) || ratio(a) - ratio(b) || a.name.localeCompare(b.name));
}

function classifyRows(rows, skillIds = []) {
  const current = new Set(skillIds);
  return rows.map(row => {
    const card = row.kind === 'deck' ? String(row.id || '').replace(/^deck-/, '') : null;
    const retired = !!card && !current.has(card) && !INTERNAL_JOBS.has(card);
    const quiet = !retired && row.useful === null && !(row.dots || []).some(dot => dot === 'fail' || dot === 'miss') && row.lastRun?.ok !== false;
    return { ...row, retired, retiredInto: retired ? (RETIRED_INTO[card] || null) : null, quiet };
  });
}

/* ---------- reading the files ---------- */
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/* the report family: the file name before its -YYYYMMDD[-HHMM] or -YYYY-MM-DD stamp */
function stackOf(file) {
  const base = String(file).replace(/\.html?$/i, '');
  const m = base.match(/^(.+?)-(?:\d{8}(?:-\d{4})?|\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : base;
}
function stampOf(file) {
  const m = String(file).match(/-(\d{4})-?(\d{2})-?(\d{2})(?:-(\d{2})(\d{2}))?\.html?$/i);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4] || '12'}:${m[5] || '00'}:00Z`) : null;
}
function readJsonl(file) {
  let raw = ''; try { raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (_) { } }
  return out;
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; } }
const ms = v => { const t = Date.parse(v || ''); return Number.isFinite(t) && t > 946684800000 ? t : null; };

/* tools/install-hq-routines.ps1 is where the Windows tasks' commands and triggers are written down */
const DOW = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
function triggerCron(trigger) {
  const every = trigger.match(/Every\s+(\d+)/i);
  if (every) return +every[1] === 1 ? '0 * * * *' : `0 */${every[1]} * * *`;
  const at = trigger.match(/'(\d{1,2}):(\d{2})'\s*\)?\s*$/);
  if (!at) return null;
  const time = `${+at[2]} ${+at[1]}`;
  if (/^\(?\s*Daily/i.test(trigger)) return `${time} * * *`;
  const days = [...trigger.matchAll(/'(\w+day)'|Weekly\s+(\w+day)/gi)].map(m => DOW[(m[1] || m[2]).toLowerCase()]).filter(d => d !== undefined);
  return days.length ? `${time} * * ${days.join(',')}` : null;
}
function installedTasks(file) {
  let src = ''; try { src = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  return [...src.matchAll(/Name\s*=\s*'([^']+)';\s*Args\s*=\s*'([^']+)';\s*Trigger\s*=\s*(.+?);\s*Limit/g)]
    .map(([, name, args, trigger]) => ({ name, args, cron: triggerCron(trigger.trim()) }));
}
function reportKey(args) {
  const card = String(args || '').match(/run-card\.mjs\s+([a-z0-9-]+)/i);
  if (card) return card[1];
  const tool = String(args || '').match(/tools\\([a-z0-9-]+)\.mjs\s+([a-z0-9-]+)/i);
  return tool ? (tool[1] === 'hq-sentinel' ? null : tool[1] + '-' + tool[2]) : null;
}

function collect({ kit, now = Date.now(), tz = 'America/New_York', routines = [] } = {}) {
  const runsDir = path.join(kit, 'os-runs'), artDir = path.join(kit, 'artifacts');
  const outcomes = readJsonl(path.join(runsDir, 'routine-outcomes.jsonl'));
  const sentinel = readJsonl(path.join(runsDir, 'sentinel.jsonl'));
  const events = readJsonl(path.join(runsDir, 'events.jsonl'));
  const opens = readJsonl(path.join(kit, 'data', 'artifact-opens.jsonl')).map(o => ({ file: o.file, ts: ms(o.ts) })).filter(o => o.file && o.ts);
  const automations = readJson(path.join(kit, 'config', 'automations.json'), {});
  const skillIds = readJson(path.join(kit, 'os-config.json'), {}).skills?.map(skill => skill.id) || [];
  const installed = installedTasks(path.join(kit, 'tools', 'install-hq-routines.ps1'));

  /* when each history starts: before it, a quiet scheduled day is unknown, not missed */
  const first = list => list.reduce((m, t) => (t && (m === null || t < m) ? t : m), null);
  const historySince = first([first(sentinel.map(l => ms(l.ts))), first(events.map(e => ms(e.ts))), first(outcomes.map(o => ms(o.ts)))]);

  /* Task Scheduler / desktop observations: each sentinel "missed" result and routine.* event carries a lastRunAt */
  const obs = new Map();
  const observe = d => { if (!d || !d.id) return; if (!obs.has(d.id)) obs.set(d.id, []); obs.get(d.id).push(d); };
  for (const l of sentinel) for (const r of l.results || []) if (String(r.id).startsWith('routine-missed:')) observe(r.data);
  for (const e of events) if (/^routine\./.test(e.type)) observe(e.data);
  const obsRuns = id => {
    const seen = new Map();
    for (const d of obs.get(id) || []) {
      const t = ms(d.lastRunAt); if (!t || Number(d.lastResult) === NEVER_RAN) continue;
      seen.set(t, { ts: t, ok: d.lastResult === undefined || d.lastResult === null || OK_RESULTS.has(Number(d.lastResult)) });
    }
    return [...seen.values()];
  };
  /* the sentinel's latest look found no fire due since its scan floor or the task's creation: don't expect runs */
  const notDue = id => { const l = (obs.get(id) || []).slice(-1)[0]; return !!l && !l.lastExpected; };

  /* deck runs: os-runs/<card>-<epochms>.log, settled by the outcome written when the run ended */
  const logs = [];
  let names = []; try { names = fs.readdirSync(runsDir); } catch (_) { }
  for (const f of names) { const m = f.match(/^([a-z0-9-]+?)-(\d{13})\.log$/); if (m) logs.push({ card: m[1], ts: +m[2], file: f }); }
  const cardRuns = card => {
    const outs = outcomes.filter(o => o.routine === card && (o.source || 'desktop') === 'deck').map(o => ({ ts: ms(o.ts), ok: o.status !== 'failed' })).filter(r => r.ts);
    const own = logs.filter(l => l.card === card);
    const unsettled = own.filter(l => !outs.some(o => o.ts >= l.ts && o.ts - l.ts < 3 * 3600e3)).map(l => ({ ts: l.ts, ok: true }));
    return { runs: [...outs, ...unsettled], since: first(own.map(l => l.ts)), log: own.sort((a, b) => b.ts - a.ts)[0]?.file || null };
  };

  /* reports on the ring and in the trash */
  const reports = [];
  for (const [dir, trashed] of [[artDir, false], [path.join(artDir, '_trash'), true]]) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => /\.html?$/i.test(f)); } catch (_) { }
    for (const file of files) {
      let at = stampOf(file);
      if (!at) { try { at = fs.statSync(path.join(dir, file)).mtimeMs; } catch (_) { continue; } }
      reports.push({ file, at, trashed, stack: stackOf(file) });
    }
  }
  const reportsFor = key => key ? reports.filter(r => r.stack === key) : [];

  const days = lastDays(now, tz);
  const rows = [];
  const add = ({ id, name, kind, cron, runs, since, expect = true, reportKeyName, log }) => {
    const own = reportsFor(reportKeyName);
    const newest = own.filter(r => !r.trashed).sort((a, b) => b.at - a.at)[0];
    const lastRun = runs.reduce((m, r) => (r.ts > (m?.ts || 0) ? r : m), null);
    rows.push({
      id, name, kind, cron: cron || null,
      dots: dayStrip({ days, runs, expected: expect ? cronExpected(cron, tz, now) : () => false, since: first([since, historySince]), tz }),
      useful: keptRatio(own, opens, { now }), noisy: isNoisy(own),
      lastRun: lastRun ? { at: new Date(lastRun.ts).toISOString(), ok: lastRun.ok } : null,
      open: newest ? '/artifacts/' + encodeURIComponent(newest.file) : log ? '/api/pulse/log?file=' + encodeURIComponent(log) : null
    });
  };

  /* 1. Windows tasks (config/automations.json + the installer) */
  const routineByKey = new Map(routines.map(r => [String(r.id).replace(/^rt:(hq-)?/, ''), r]));
  const winNames = [...new Set([...Object.keys(automations.windowsTasks?.jobs || {}), ...installed.map(t => t.name)])];
  const cardsOwned = new Set();
  for (const name of winNames) {
    const id = 'windows-' + slug(name), task = installed.find(t => t.name === name) || {};
    const key = reportKey(task.args), mode = String(task.args || '').match(/hq-sentinel\.mjs\s+(\w+)/)?.[1];
    const routine = routineByKey.get(slug(name).replace(/^agentic-hq-/, ''));
    const cron = routine ? (routine.status === 'active' ? routine.cron : null) : task.cron;
    let runs = obsRuns(id), since = null, log = null;
    if (mode) runs = runs.concat(sentinel.filter(l => l.mode === mode).map(l => ({ ts: ms(l.ts), ok: true })).filter(r => r.ts));
    if (/run-card\.mjs/.test(task.args || '') && key) { const c = cardRuns(key); runs = runs.concat(c.runs); since = c.since; log = c.log; cardsOwned.add(key); }
    if (/second brain refresh/i.test(name)) {
      const ref = readJsonl(path.join(runsDir, 'second-brain-scheduled.jsonl')).map(l => ({ ts: ms(l.at), ok: l.ok !== false })).filter(r => r.ts);
      runs = runs.concat(ref); since = first(ref.map(r => r.ts));
    }
    add({ id, name: name.replace(/^Agentic HQ /, ''), kind: 'windows', cron, runs, since, expect: !notDue(id), reportKeyName: key, log });
  }

  /* 2. Claude desktop scheduled routines (recurring ones, as /api/routines lists them) */
  const desk = new Map();
  for (const r of routines) if (r.source === 'agent-tasks' && r.status !== 'ondemand' && (r.cron || r.times?.length)) desk.set(String(r.id).replace(/^rt:task-/, ''), r);
  for (const task of Object.keys(automations.desktopRoutines || {})) if (!desk.has(task)) desk.set(task, null);
  for (const [task, r] of desk) {
    const runs = obsRuns(task).concat(outcomes.filter(o => o.routine === task && (o.source || 'desktop') === 'desktop').map(o => ({ ts: ms(o.ts), ok: o.status !== 'failed' })).filter(x => x.ts));
    if (r && ms(r.lastRunAt) && !runs.some(x => Math.abs(x.ts - ms(r.lastRunAt)) < 60000)) runs.push({ ts: ms(r.lastRunAt), ok: true });
    add({ id: 'desktop-' + task, name: r ? r.name : task, kind: 'desktop', cron: r && r.status === 'active' ? r.cron : null, runs, expect: !notDue(task), reportKeyName: task });
  }

  /* 3. deck cards that ran (left a log) in the last 7 days and no Windows task already owns */
  const weekAgo = now - STRIP_DAYS * DAY;
  const cards = new Set(logs.filter(l => l.ts >= weekAgo).map(l => l.card));
  for (const card of cards) {
    if (cardsOwned.has(card)) continue;
    const c = cardRuns(card);
    add({ id: 'deck-' + card, name: card, kind: 'deck', cron: null, runs: c.runs, since: c.since, reportKeyName: card, log: c.log });
  }

  return { fetched: new Date(now).toISOString(), timeZone: tz, days, keptDays: KEPT_DAYS, historySince: historySince ? new Date(historySince).toISOString() : null, rows: classifyRows(sortRows(rows), skillIds) };
}

module.exports = { collect, classifyRows, dayStrip, keptRatio, isNoisy, sortRows, cronExpected, lastDays, dayOf, minutesOf, stackOf, triggerCron, reportKey, installedTasks };
