'use strict';
/* RECEIPTS (P2): what your yeses actually did.
   Pure: the caller passes gotcha proposals, lessons, pulse rows, radar decisions and routine outcomes in.
   An applied gotcha "recurred" when a later lesson covers the same ground (token Jaccard >= 0.5); otherwise
   it "is holding". Also surfaces noisy automations to retire and radar builds waiting on merge/discard.
   Tested in test/receipts.test.cjs. */
const DAY = 864e5;
const WEEK = 7 * DAY;
const CAP = 10;
const TONE = { bad: 0, warn: 1, good: 2 };

const msOf = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = /^\d+$/.test(v.trim()) ? +v.trim() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* lowercase words of 4+ letters/digits */
function tokens(s) {
  const out = new Set();
  for (const w of String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []) if (w.length >= 4) out.add(w);
  return out;
}
function jaccard(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

/* 'YYYY-MM-DD' for a date-only compare; ISO strings keep their own date */
function dateOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
  }
  const t = msOf(v);
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}
const md = d => { const p = d.split('-'); return (+p[1]) + '/' + (+p[2]); };

function receipts({ proposals = [], lessons = [], pulseRows = [], radarDecisions = {}, outcomes = [], now = Date.now() } = {}) {
  const since = now - WEEK;
  const applied = (Array.isArray(proposals) ? proposals : []).filter(p => p && p.status === 'applied');
  const lessonList = (Array.isArray(lessons) ? lessons : []).filter(l => l && l.verified);
  const items = [];
  let approved = 0, recurred = 0, holding = 0;
  const holdBySkill = new Map(); // one row per skill, so three fixes to one skill don't read as three identical lines

  for (const p of applied) {
    const appliedAt = dateOf(p.appliedAt);
    const appliedMs = msOf(p.appliedAt);
    const inWeek = appliedMs !== null && appliedMs >= since && appliedMs <= now;
    if (inWeek) approved++;
    const cameBack = lessonList.some(l => {
      const verified = dateOf(l.verified);
      return verified !== null && appliedAt !== null && verified > appliedAt && jaccard(p.text, l.title) >= 0.5;
    });
    const skill = p.skill || 'skill';
    if (cameBack) {
      recurred++;
      if (appliedAt) items.push({ kind: 'recurred', tone: 'bad', text: skill + ': the fix you approved on ' + md(appliedAt) + ' came back', target: 'learned' });
    } else {
      holding++;
      if (inWeek && appliedAt) {
        const h = holdBySkill.get(skill) || { count: 0, first: appliedAt };
        h.count++;
        if (appliedAt < h.first) h.first = appliedAt;
        holdBySkill.set(skill, h);
      }
    }
  }
  for (const [skill, h] of holdBySkill) {
    const what = h.count > 1 ? h.count + ' fixes holding' : 'holding';
    items.push({ kind: 'holding', tone: 'good', text: skill + ': ' + what + ' since ' + md(h.first), target: 'learned' });
  }

  for (const row of Array.isArray(pulseRows) ? pulseRows : []) {
    if (!row || !row.noisy) continue;
    const kept = num(row.useful && row.useful.kept) ?? 0, total = num(row.useful && row.useful.total) ?? 0;
    items.push({ kind: 'retire', tone: 'warn', text: (row.name || row.id || 'automation') + ': kept ' + kept + ' of ' + total + '. Retire it?', target: 'automations' });
  }

  const decisions = radarDecisions && radarDecisions.items;
  const rows = Array.isArray(decisions) ? decisions : decisions && typeof decisions === 'object' ? Object.values(decisions) : [];
  for (const d of rows) {
    if (!d || d.decision !== 'implement' || d.discarded || d.merged) continue;
    if (!['done', 'not built', 'failed'].includes(d.jobStatus)) continue;
    items.push({ kind: 'radar', tone: 'warn', text: (d.title || 'Radar build') + ': build ' + d.jobStatus + '. Merge or discard', target: 'radar' });
  }

  let runs = 0, succeeded = 0, failed = 0;
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o) continue;
    const at = msOf(o.endedAt);
    if (at === null || at < since || at > now) continue;
    runs++;
    if (o.status === 'succeeded') succeeded++;
    else if (o.status === 'failed') failed++;
  }

  const sorted = [...items].sort((a, b) => TONE[a.tone] - TONE[b.tone]).slice(0, CAP);
  return { week: { approved, recurred, holding, runs, succeeded, failed }, items: sorted };
}

module.exports = { receipts, jaccard, tokens };
