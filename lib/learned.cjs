'use strict';
/* WHAT HQ LEARNED (os.html w-learned, GET /api/learned; the Learned page via /api/learned/standings and /status).
   This week: lessons added / updated / superseded, from the session-lessons run logs' "Lessons: ..." line,
   plus the lesson files touched and the 3 newest lessons. Waiting on you: the ranked standings in
   data/standings/learned.json (lib/gotcha-proposals.cjs builds them, lib/gotcha-assess.cjs judges them), falling back
   to the pending proposals in data/gotcha-proposals.json. Folded in: Gotchas approved into skills, all time and this
   week. Pure functions first (tested in test/learned.test.cjs). No model calls. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { firesOn } = require('../refresh/lib/routines.cjs');
const { dayOf, minutesOf, installedTasks } = require('./pulse.cjs');
const standings = require('./standings.cjs');
const { withLock } = require('./store-lock.cjs');
const gotchas = require('./gotcha-proposals.cjs');
const { TIME_SAVED, EFFORT, fallbackAssessment } = require('./gotcha-assess.cjs');
const { LEARNED_OPTS } = gotchas;
const DAY = 864e5, WEEK = 7 * DAY, LESSONS_LINE = /^\W*Lessons:\W*(\d+)\s+added,\s*(\d+)\s+updated,\s*(\d+)\s+superseded/i;
function lessonCounts(runs, { now = Date.now(), since = now - WEEK } = {}) {
  const out = { added: 0, updated: 0, superseded: 0, runs: 0 };
  for (const r of runs) { if (r.ts < since || r.ts > now) continue; const lines = String(r.text || '').split(/\r?\n/).filter(l => LESSONS_LINE.test(l)), m = lines.length && lines.at(-1).match(LESSONS_LINE); if (!m) continue; out.added += +m[1]; out.updated += +m[2]; out.superseded += +m[3]; out.runs++; }
  return out;
}
function parseLessons(body, topic, mtime = 0) { const out = []; String(body || '').split(/\r?\n/).forEach((line, i) => { if (!/^\s*-\s+\*\*/.test(line) || /~~/.test(line)) return; const title = line.match(/^\s*-\s+\*\*(.+?)\*\*/)?.[1]?.trim(); if (!title) return; const verified = [...line.matchAll(/\(verified\s+(\d{4}-\d\d-\d\d)\)/gi)].at(-1)?.[1] || null; out.push({ topic, title: title.replace(/[.:;]+$/, ''), verified, line: i + 1, mtime }); }); return out; }
function newestLessons(lessons, n = 3) { return [...lessons].sort((a, b) => String(b.verified || '').localeCompare(String(a.verified || '')) || b.mtime - a.mtime || b.line - a.line).slice(0, n); }
/* Without standings: one row per lesson, listing every skill still waiting on it. */
function pendingProposals(state) {
  const order = (a, b) => (b.recurrence || 1) - (a.recurrence || 1) || Date.parse(b.proposedAt || 0) - Date.parse(a.proposedAt || 0), byLesson = new Map();
  for (const p of (state.proposals || []).filter(p => p.status === 'proposed')) { const key = gotchas.lessonKey(p.text) || p.id; byLesson.set(key, [...(byLesson.get(key) || []), p]); }
  return [...byLesson.values()].map(group => group.sort(order)).sort((a, b) => order(a[0], b[0])).map(group => { const p = group[0], assessment = p.assessment || fallbackAssessment(p); return { id: p.id, ids: group.map(x => x.id), skill: p.skill, skills: group.map(x => x.skill), text: String(p.text || '').replace(/^-\s*/, '').slice(0, 300), topic: path.basename(String((p.source || [])[0] || '').replace(/:\d+$/, ''), '.md') || null, recurrence: p.recurrence || 1, proposedAt: p.proposedAt || null, assessment: { ...assessment, timeLabel: TIME_SAVED[assessment.timeSaved], effortLabel: EFFORT[assessment.effort] } }; });
}
function approvedCounts(state, { now = Date.now(), since = now - WEEK } = {}) { const applied = (state.proposals || []).filter(p => p.status === 'applied'); return { allTime: applied.length, thisWeek: applied.filter(p => Date.parse(p.appliedAt || 0) >= since).length, dismissed: (state.proposals || []).filter(p => p.status === 'rejected').length }; }
function nextFire(cron, tz, now = Date.now()) { if (!cron) return null; const today = dayOf(now, tz), nowMin = minutesOf(now, tz); for (let i = 0; i < 8; i++) { const day = new Date(Date.parse(today + 'T12:00:00Z') + i * DAY).toISOString().slice(0, 10), m = firesOn({ status: 'active', cron }, day, tz).find(t => i > 0 || t > nowMin); if (m !== undefined) return { day, minutes: m }; } return null; }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; } }
function tail(file, bytes = 64 * 1024) { try { const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n); fs.closeSync(fd); return buf.toString('utf8'); } catch (_) { return ''; } }
function withAssessment(item) { const a = item.data?.assessment || fallbackAssessment(item.data); return { ...item, data: { ...item.data, assessment: { ...a, timeLabel: TIME_SAVED[a.timeSaved], effortLabel: EFFORT[a.effort] } } }; }
function collect({ kit, lessonsDir, dataDir = path.join(kit, 'data'), now = Date.now(), tz = 'America/New_York' } = {}) {
  const since = now - WEEK, runsDir = path.join(kit, 'os-runs'); let names = []; try { names = fs.readdirSync(runsDir); } catch (_) {}
  const runs = names.map(f => f.match(/^session-lessons-(\d{13})\.log$/)).filter(Boolean).map(m => ({ ts: +m[1], file: m[0] })).filter(r => r.ts >= since).map(r => ({ ts: r.ts, text: tail(path.join(runsDir, r.file)) }));
  const lessons = [], touched = []; let files = []; try { files = fs.readdirSync(lessonsDir).filter(f => /\.md$/i.test(f) && !/^readme\.md$/i.test(f)); } catch (_) {}
  for (const f of files) { const full = path.join(lessonsDir, f); let st, body; try { st = fs.statSync(full); body = fs.readFileSync(full, 'utf8'); } catch (_) { continue; } const topic = f.replace(/\.md$/i, ''); lessons.push(...parseLessons(body, topic, st.mtimeMs)); if (st.mtimeMs >= since) touched.push(topic); }
  const state = readJson(path.join(dataDir, 'gotcha-proposals.json'), { proposals: [] });
  // A corrupt standings file must not take down the homepage widget: fall back to the pending proposals and say why.
  let store, standingsError = null;
  try { store = standings.load(path.join(dataDir, 'standings', 'learned.json'), 'learned'); }
  catch (error) { store = standings.emptyStore('learned'); standingsError = error.code || error.message; }
  const ranked = standings.view(store, { status: 'ranked', limit: 10, opts: LEARNED_OPTS });
  // One row per lesson: ids and skills are the ones still waiting on it (Approve applies them all).
  const waiting = item => { const targets = gotchas.targetsOf(item), open = targets.filter(t => t.status === 'proposed'); return open.length ? open : targets; };
  const pending = ranked.items.length ? ranked.items.map(withAssessment).map(i => ({
    id: i.data?.proposalId || store.items[i.id].key, standingsId: i.id, skill: i.data?.skill || i.category,
    ids: waiting(store.items[i.id]).map(t => t.proposalId), skills: waiting(store.items[i.id]).map(t => t.skill),
    text: String(i.data?.text || i.title).replace(/^-\s*/, ''),
    topic: path.basename(String(i.data?.source?.[0] || '').replace(/:\d+$/, ''), '.md') || null,
    recurrence: i.data?.recurrence || 1, proposedAt: i.firstSeen, assessment: i.data.assessment,
    rank: i.rank, tier: i.tier, movement: i.movement, score: i.score, reason: i.reason
  })) : pendingProposals(state);
  const task = installedTasks(path.join(kit, 'tools', 'install-hq-routines.ps1')).find(t => /run-card\.mjs\s+gotcha-proposals/.test(t.args)), next = task ? nextFire(task.cron, tz, now) : null;
  return { fetched: new Date(now).toISOString(), timeZone: tz, week: { ...lessonCounts(runs, { now, since }), filesTouched: touched.sort(), total: lessons.length }, newest: newestLessons(lessons, 3).map(({ topic, title, verified }) => ({ topic, title, verified })), pending, standings: { ...ranked, items: ranked.items.map(i => ({ id: i.id, rank: i.rank, tier: i.tier, movement: i.movement, score: i.score, title: i.title, category: i.category, reason: i.reason })) }, openTotal: ranked.items.length ? ranked.counts.open : pending.length, standingsError, approved: approvedCounts(state, { now, since }), lastProposalRun: store.updatedAt || state.lastRunAt || null, nextProposals: next ? { day: next.day, time: String(Math.floor(next.minutes / 60)).padStart(2, '0') + ':' + String(next.minutes % 60).padStart(2, '0'), cron: task.cron } : null };
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function forServer({ kit, lessonsDir, dataDir = path.join(kit, 'data'), skillsRoot = path.join(os.homedir(), '.claude', 'skills'), emit = () => {}, now = () => new Date(), lockTimeoutMs = 3000 }) {
  const storeFile = path.join(dataDir, 'standings', 'learned.json'), proposalsFile = path.join(dataDir, 'gotcha-proposals.json');
  const date = () => { const value = typeof now === 'function' ? now() : now; return value instanceof Date ? value : new Date(value); };
  /* The proposal behind each of an item's skills; one missing from the file (an older item) is filed from the item. */
  function ensureProposals(item) {
    const state = gotchas.readState(proposalsFile), byId = new Map(state.proposals.map(p => [p.id, p]));
    let added = false;
    const list = gotchas.targetsOf(item).map(t => {
      if (byId.has(t.proposalId)) return byId.get(t.proposalId);
      const proposal = {
        id: t.proposalId, skill: t.skill, file: t.file || item.data?.file, section: item.data?.section || 'Gotchas',
        text: item.data?.text || `- ${item.title}`, source: item.data?.source || item.refs,
        recurrence: item.data?.recurrence || 1, sourceAt: item.data?.sourceAt,
        proposedAt: item.firstSeen, status: t.status || 'proposed'
      };
      state.proposals.push(proposal); byId.set(proposal.id, proposal); added = true;
      return proposal;
    });
    if (added) gotchas.atomicWrite(proposalsFile, JSON.stringify(state, null, 2) + '\n');
    return list;
  }
  const batches = ids => Array.from({ length: Math.ceil(ids.length / 5) }, (_, i) => ids.slice(i * 5, i * 5 + 5));
  return { async handle(method, subpath, params = new URLSearchParams(), input = {}) {
    if (method === 'GET' && subpath === '/standings') {
      const status = params.get?.('status') || 'ranked';
      if (!['ranked', 'open', 'approved', 'done', 'trashed', 'all'].includes(status)) throw httpError(400, 'invalid status');
      const int = (name, fallback) => { const n = Number.parseInt(params.get?.(name) ?? '', 10); return Number.isFinite(n) ? n : fallback; };
      const limit = Math.min(500, Math.max(1, int('limit', 100))), offset = Math.max(0, int('offset', 0));
      const view = standings.view(standings.load(storeFile, 'learned'), {
        query: params.get?.('q') || '', status, limit, offset, opts: LEARNED_OPTS
      });
      view.items = view.items.map(withAssessment);
      return view;
    }
    if (method !== 'POST' || subpath !== '/status') throw httpError(404, 'not found');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError(400, 'status input must be an object');
    if (!['done', 'trashed', 'open'].includes(input.status)) throw httpError(400, 'status must be done, trashed, or open');
    return withLock(storeFile, () => {
    let store = standings.load(storeFile, 'learned');
    // An item folded into another (one entry per lesson) answers to its old id too.
    const id = Object.hasOwn(store.items, input.id) ? input.id : standings.resolveId(store, String(input.id ?? ''));
    if (!id) throw httpError(404, 'unknown item');
    let item = store.items[id];
    if (input.status === 'open' && item.status !== 'trashed') throw httpError(409, 'only dismissed items can be reopened');
    if (input.status !== 'open' && item.status !== 'open') throw httpError(409, 'only open items can be applied or dismissed');
    // Every skill the lesson is waiting on, or only the ones named in skills.
    const only = Array.isArray(input.skills) && input.skills.length ? new Set(input.skills.map(String)) : null;
    const chosen = ensureProposals(item).filter(p => !only || only.has(p.skill)), at = date();
    const applied = [], dismissed = [];
    if (input.status === 'done') {
      const ids = chosen.filter(p => p.status === 'proposed').map(p => p.id);
      if (!ids.length) throw httpError(409, 'no skill is waiting on this item');
      for (const batch of batches(ids)) applied.push(...gotchas.applyProposals({ ids: batch, dataFile: proposalsFile, standingsFile: storeFile, skillsRoot, now: at }).applied);
      for (const a of applied) emit({ type: 'gotcha.approved', source: 'hq-learned', severity: 'info', key: 'gotcha.approved:' + a.id,
        summary: `Gotcha ${a.id} folded into ${a.skill}${a.duplicate ? ' (already there)' : ''}`,
        data: { id: a.id, skill: a.skill, duplicate: a.duplicate } });
    } else if (input.status === 'trashed') {
      const ids = chosen.filter(p => p.status === 'proposed').map(p => p.id);
      if (!ids.length) throw httpError(409, 'no skill is waiting on this item');
      for (const batch of batches(ids)) dismissed.push(...gotchas.dismissProposals({ ids: batch, dataFile: proposalsFile, standingsFile: storeFile, now: at }).dismissed);
      for (const d of dismissed) emit({ type: 'gotcha.dismissed', source: 'hq-learned', severity: 'info', key: 'gotcha.dismissed:' + d.id,
        summary: `Gotcha ${d.id} for ${d.skill} trashed`, data: { id: d.id, skill: d.skill } });
    } else {
      const state = gotchas.readState(proposalsFile), wanted = new Set(chosen.map(p => p.id));
      for (const p of state.proposals) {
        if (!wanted.has(p.id) || p.status !== 'rejected') continue;
        p.status = 'proposed';
        delete p.rejectedAt;
        delete p.rejectedBy;
        delete p.rejectedReason;
        // The next proposals run keeps a reopened item open even when its lesson is gone (buildProposals checks this).
        p.reopenedAt = at.toISOString();
        p.reopenedBy = 'widget';
      }
      gotchas.atomicWrite(proposalsFile, JSON.stringify(state, null, 2) + '\n');
      gotchas.syncStandings(storeFile, state, [...wanted], at.toISOString(), input.note, { reopen: true });
    }
    store = standings.load(storeFile, 'learned');
    item = store.items[id];
    return { ok: true, item: withAssessment(item), applied, dismissed };
    }, { timeoutMs: lockTimeoutMs, busyMessage: gotchas.LOCK_BUSY });
  } };
}
module.exports = { LEARNED_OPTS, collect, forServer, lessonCounts, parseLessons, newestLessons, pendingProposals, approvedCounts, nextFire };
