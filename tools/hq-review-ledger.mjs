import fs from 'node:fs';
import path from 'node:path';
import { localStamp } from '../lib/local-stamp.cjs';

const LEVELS = new Set(['act', 'watch']);
const ACTIVE = new Set(['new', 'open']);

export function slug(value) {
  return String(value || 'unknown').toLowerCase().replace(/\([^)]*\)\s*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unknown';
}

export function summarizeOutcomes(outcomes, now = Date.now()) {
  const byStatus = {}, tasks = {};
  for (const o of outcomes) {
    if (o.status === 'running') continue;
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    const task = o.source === 'hq' ? String(o.taskType || 'unknown') : `${o.source} ${String(o.sourceId || '').split(':').pop()}`;
    const end = Number(o.end || Date.parse(o.endedAt || o.startedAt));
    const t = (tasks[task] ||= { events: [], maxSec: 0 });
    t.events.push({ status: o.status, end });
    t.maxSec = Math.max(t.maxSec, Math.round((o.durationMs || 0) / 1000));
  }
  const rows = Object.entries(tasks).map(([task, t]) => {
    t.events.sort((a, b) => b.end - a.end);
    const last = t.events[0];
    const lastSuccess = t.events.find(e => e.status === 'succeeded');
    const sinceSuccess = lastSuccess ? t.events.filter(e => e.end > lastSuccess.end) : t.events;
    const failedSinceSuccess = sinceSuccess.filter(e => e.status !== 'succeeded').length;
    return {
      task, id: slug(task), runs: t.events.length, failed: failedSinceSuccess, lastStatus: last.status,
      lastHoursAgo: Math.round(((now - last.end) / 36e5) * 10) / 10,
      lastOkHoursAgo: lastSuccess ? Math.round(((now - lastSuccess.end) / 36e5) * 10) / 10 : null,
      slowestSec: t.maxSec
    };
  });
  return { byStatus, tasks: rows, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
}

export function localChecks(c) {
  const out = [], add = (id, level, title, evidence) => out.push({ id, level, title, evidence });
  if (c.hq.ok === false || c.hq.engine === false) add('hq-down:engine', 'act', 'HQ engine is down', `health ok=${c.hq.ok}, engine=${c.hq.engine}`);
  if (c.hq.workspaceSet === false) add('workspace-missing:root', 'act', 'No workspace is set', 'health workspaceSet=false');
  if (c.hq.runner && c.hq.runner !== 'ready') add('runner-down:deck', 'act', 'Deck runner is not set up', `runner=${c.hq.runner}`);
  for (const k of c.companionsDown) add(`companion-down:${slug(k)}`, 'act', `Companion ${k} is down`, `health companions.${k}=false`);
  for (const a of c.appsDown) add(`app-down:${slug(a)}`, 'watch', `Micro app ${a} is not responding`, 'apps live=false');
  for (const m of c.meters) {
    for (const w of m.windows) {
      const subject = `${slug(m.id)}:${slug(w.label)}`;
      if (w.resetsInMin != null && w.resetsInMin <= 0) { add(`meter-reset:${subject}`, 'watch', `${m.id} ${w.label} window has reset since the last reading`, `last reading ${w.used}% used`); continue; }
      const reset = w.resetsInMin != null ? `, resets in ${w.resetsInMin} min` : '';
      if (w.used >= 90) add(`meter-high:${subject}`, 'act', `${m.id} ${w.label} usage is nearly spent`, `${w.used}% used${reset}`);
      else if (w.used >= 75 || (w.label === 'credits' && w.used >= 80)) add(`meter-high:${subject}`, 'watch', `${m.id} ${w.label} usage is high`, `${w.used}% used${reset}`);
      if (w.runsOutInMin != null && w.runsOutInMin > 0) add(`meter-runout:${subject}`, 'watch', `${m.id} ${w.label} is projected to run out before it resets`, `runs out in ${w.runsOutInMin} min${reset}`);
    }
    if (m.stale || m.readingAgeMin > 120) add(`meter-stale:${slug(m.id)}`, 'watch', `${m.id} meter reading is stale, so its numbers may be wrong`, `reading is ${m.readingAgeMin ?? '?'} min old`);
  }
  for (const t of c.runs24h.tasks) {
    const subject = t.id || slug(t.task);
    if (t.lastStatus !== 'succeeded' && t.failed >= 2) add(`task-failing:${subject}`, 'act', `${t.task} keeps failing`, `${t.failed} failures since its last success; last ${t.lastStatus} ${t.lastHoursAgo}h ago, last success ${t.lastOkHoursAgo ?? 'none'}h ago`);
    else if (t.lastStatus !== 'succeeded') add(`task-failing:${subject}`, 'watch', `${t.task} last run ${t.lastStatus}`, `${t.failed} failure since its last success; ${t.lastHoursAgo}h ago`);
    if (t.slowestSec > 900) add(`task-slow:${subject}`, 'watch', `${t.task} ran long`, `slowest run ${Math.round(t.slowestSec / 60)} min`);
  }
  const fails = c.runs24h.total - (c.runs24h.byStatus.succeeded || 0);
  if (c.runs24h.total >= 5 && fails / c.runs24h.total > 0.2) add('runs-failing:all', 'watch', 'Run failure rate is high', `${fails}/${c.runs24h.total} finished runs in 24h did not succeed`);
  if (c.routines.needsSetup) add('routine-missing:setup', 'act', 'Routines need setup', 'routines needsSetup=true');
  for (const r of c.routines.missed || []) add(`routine-missed:${slug(r.id)}`, r.missed >= 3 ? 'act' : 'watch',
    `${r.name || r.id} missed scheduled fires`, `${r.missed} missed; last run ${r.lastRunAt || 'never'}; source ${r.source || 'unknown'}`);
  for (const d of c.machine.disks) {
    const drive = slug(d.drive.replace(':', ''));
    if (d.freePct < 10 || d.freeGB < 20) add(`disk-full:${drive}`, 'act', `Drive ${d.drive} is almost full`, `${d.freeGB} GB free (${d.freePct}%)`);
    else if (d.freePct < 15) add(`disk-full:${drive}`, 'watch', `Drive ${d.drive} is getting full`, `${d.freeGB} GB free (${d.freePct}%)`);
  }
  if (c.machine.ramUsedPct >= 92) add('ram-high', 'act', 'Memory is nearly exhausted', `${c.machine.ramUsedPct}% of ${c.machine.ramTotalGB} GB in use`);
  else if (c.machine.ramUsedPct >= 85) add('ram-high', 'watch', 'Memory use is high', `${c.machine.ramUsedPct}% of ${c.machine.ramTotalGB} GB in use`);
  if (c.machine.leakedTestBrowsers > 0) add('browser-leak:hqcdp', 'act', 'Leaked headless test browsers', `${c.machine.leakedTestBrowsers} msedge processes with an hqcdp- profile`);
  if (c.artifacts.newestHoursAgo != null && c.artifacts.newestHoursAgo > 72) add('artifact-stale:ring', 'watch', 'No new ring artifacts in 3 days', `newest is ${c.artifacts.newestHoursAgo}h old`);
  for (const g of c.gaps) {
    const name = String(g).match(/^\/api\/([^ ]+)/)?.[1] || g;
    add(`source-missing:${slug(name)}`, 'watch', `Missing data source: ${name}`, g);
  }
  return out.sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === 'act' ? -1 : 1));
}

export function emptyLedger() { return { findings: {}, runs: [] }; }

export function loadLedger(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && value.findings && Array.isArray(value.runs) ? value : emptyLedger();
  } catch { return emptyLedger(); }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

export function dismissTrashed(ledger, trashDir) {
  const next = clone(ledger);
  const trashed = new Set();
  try { for (const name of fs.readdirSync(trashDir)) trashed.add(name.toLowerCase()); } catch { /* no trash folder */ }
  for (const run of next.runs) {
    if (run.dismissed || !trashed.has(path.basename(run.report || '').toLowerCase())) continue;
    for (const id of run.ids || []) if (next.findings[id]) next.findings[id].status = 'dismissed';
    run.dismissed = true;
  }
  return next;
}

export function previewDiff(ledger, findings) {
  const current = new Map(findings.map(f => [f.id, f]));
  const diff = { new: [], fixed: [], open: [], dismissed: [], escalated: [] };
  for (const f of findings) {
    const old = ledger.findings[f.id];
    if (!old) diff.new.push(f);
    else if (old.status === 'dismissed') {
      if (old.level === 'watch' && f.level === 'act') diff.escalated.push({ ...f, note: 'escalated from dismissed watch to act' });
      else diff.dismissed.push(f);
    } else diff.open.push({ ...f, seenCount: (old.seenCount || 0) + 1, firstSeen: old.firstSeen });
  }
  for (const old of Object.values(ledger.findings)) if (ACTIVE.has(old.status) && !current.has(old.id)) diff.fixed.push(old);
  return diff;
}

export function applyRun(ledger, findings, { at, report }) {
  const next = clone(ledger), current = new Set(findings.map(f => f.id));
  for (const old of Object.values(next.findings)) if (ACTIVE.has(old.status) && !current.has(old.id)) old.status = 'fixed';
  for (const f of findings) {
    const old = next.findings[f.id];
    if (!old) {
      next.findings[f.id] = { id: f.id, title: f.title, level: f.level, status: 'new', firstSeen: at, lastSeen: at,
        lastEvidence: f.evidence || '', seenCount: 1, reports: [report] };
      continue;
    }
    const escalated = old.status === 'dismissed' && old.level === 'watch' && f.level === 'act';
    old.title = f.title; old.level = f.level; old.lastSeen = at; old.lastEvidence = f.evidence || old.lastEvidence || '';
    old.seenCount = (old.seenCount || 0) + 1; old.reports = [...new Set([...(old.reports || []), report])];
    old.status = old.status === 'dismissed' && !escalated ? 'dismissed' : 'open';
    if (escalated) old.lastEvidence = `${old.lastEvidence} (escalated from dismissed watch to act)`;
  }
  next.runs = [...next.runs, { at, report, ids: findings.map(f => f.id) }].slice(-50);
  return next;
}

export function parseModelAnswer(answer, checks) {
  const blocks = [...answer.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (!blocks.length) return { markdown: answer.trim(), findings: checks, valid: false };
  const block = blocks.at(-1);
  try {
    const parsed = JSON.parse(block[1]);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const checkMap = new Map(checks.map(c => [c.id, c]));
    const findings = [], seen = new Set();
    for (const raw of parsed) {
      if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string' || !LEVELS.has(raw.level) || seen.has(raw.id)) throw new Error('invalid finding');
      const check = checkMap.get(raw.id);
      if (!check && !/^model:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id)) throw new Error('invalid model id');
      findings.push(check ? { ...check, title: raw.title } : { id: raw.id, title: raw.title, level: 'watch', evidence: '' });
      seen.add(raw.id);
    }
    for (const check of checks) if (!seen.has(check.id)) findings.push(check);
    return { markdown: (answer.slice(0, block.index) + answer.slice(block.index + block[0].length)).trim(), findings, valid: true };
  } catch { return { markdown: answer.replace(block[0], '').trim(), findings: checks, valid: false }; }
}

// The name server.js writeRunReport gives this card's run report, so trashing that report dismisses its findings.
export function reportFileAt(date = new Date()) {
  return `api-hq-review-${localStamp(date)}.html`;
}

export function counts(ledger) {
  const out = { new: 0, fixed: 0, open: 0, dismissed: 0 };
  for (const f of Object.values(ledger.findings)) if (Object.hasOwn(out, f.status)) out[f.status]++;
  return out;
}

export function footer(ledger, parsed = true) {
  const c = counts(ledger);
  return `_${c.new} new · ${c.fixed} fixed · ${c.open} open · ${c.dismissed} dismissed${parsed ? '' : ' · model JSON invalid; ledger used local checks only'}_`;
}

export function promptDiff(diff) {
  const pick = rows => rows.map(f => ({ id: f.id, title: f.title, level: f.level, seenCount: f.seenCount, firstSeen: f.firstSeen, note: f.note }));
  return { new: pick(diff.new), fixed: pick(diff.fixed), open: pick(diff.open), escalated: pick(diff.escalated), dismissed: pick(diff.dismissed) };
}
