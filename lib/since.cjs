'use strict';
/* SINCE YOU LAST LOOKED (P1): what happened since the last time you opened HQ.
   Pure: the caller passes events, routine outcomes, ring artifacts, radar, email counts, YouTube
   subscriber/view history and tracker updates in. Everything older than `lastSeen` (default: 12 h ago) is
   dropped; a down+up pair on one source collapses into "went down and came back"; routine successes roll
   into one line. Never includes email subjects, senders or bodies. Tested in test/since.test.cjs. */
const HOUR = 36e5;
const DEFAULT_LOOKBACK = 12 * HOUR;
const CAP = 8;
const SEV = { bad: 0, warn: 1, good: 2, info: 3 };
const DOWN = /\.down$/i;
const UP = /\.up$/i;

const msOf = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = /^\d+$/.test(v.trim()) ? +v.trim() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sevOf = e => {
  const s = String(e && e.severity || '').toLowerCase();
  return s === 'error' || s === 'critical' ? 'bad' : s === 'warn' ? 'warn' : 'info';
};

function sinceItems({
  lastSeen = null, now = Date.now(), events = [], outcomes = [], artifacts = [], radar = null,
  email = null, emailPrev = null, youtube = [], jobs = []
} = {}) {
  const since = lastSeen === null || lastSeen === undefined || lastSeen === '' ? now - DEFAULT_LOOKBACK : msOf(lastSeen);
  const from = since === null ? now - DEFAULT_LOOKBACK : since;
  const items = [];
  const push = (kind, severity, text, target, at) => {
    if (at === null) return;
    items.push({ kind, severity, text, target, at: new Date(at).toISOString() });
  };

  /* events: a down (or any bad) followed by an up on the same source is one warn line */
  const evs = (Array.isArray(events) ? events : [])
    .map(e => ({ e, at: msOf(e && e.ts) }))
    .filter(x => x.e && x.at !== null && x.at > from)
    .sort((a, b) => a.at - b.at);
  const collapsed = new Set();
  evs.forEach((down, i) => {
    if (collapsed.has(i)) return;
    if (!DOWN.test(String(down.e.type || '')) && sevOf(down.e) !== 'bad') return;
    const j = evs.findIndex((up, k) => k > i && !collapsed.has(k)
      && up.e.source === down.e.source && UP.test(String(up.e.type || '')));
    if (j === -1) return;
    collapsed.add(i); collapsed.add(j);
    push('outage', 'warn', (down.e.source || 'service') + ' went down and came back', 'automations', evs[j].at);
  });
  evs.forEach(({ e, at }, i) => {
    if (collapsed.has(i)) return;
    push('event', sevOf(e), String(e.summary || e.key || e.type || 'event'), 'automations', at);
  });

  /* routine outcomes: failures and asks stand alone, successes roll into one line */
  const done = [];
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o) continue;
    const at = msOf(o.endedAt);
    if (at === null || at <= from) continue;
    const source = o.source || 'run';
    if (o.status === 'failed') push('outcome', 'bad', source + ' failed', 'automations', at);
    else if (o.status === 'needs-action') push('outcome', 'warn', source + ' needs you' + (o.next ? ': ' + o.next : ''), 'automations', at);
    else if (o.status === 'succeeded') done.push(at);
  }
  if (done.length) push('runs', 'good', done.length + ' runs finished fine', 'automations', Math.max(...done));

  /* new ring pages (agent-monitor.html is not a page you made) */
  const pages = (Array.isArray(artifacts) ? artifacts : [])
    .filter(a => a && a.file !== 'agent-monitor.html' && (msOf(a.created) !== null && msOf(a.created) > from));
  if (pages.length) {
    const titles = pages.map(a => a.title || a.file).filter(Boolean).slice(0, 2);
    push('artifacts', 'info', pages.length + ' new pages on the ring' + (titles.length ? ': ' + titles.join(', ') : ''),
      'ring', Math.max(...pages.map(a => msOf(a.created))));
  }

  /* radar run that found something worth trying */
  const radarAt = radar ? msOf(radar.finishedAt || radar.startedAt || radar.generatedAt) : null;
  if (radarAt !== null && radarAt > from) {
    const worth = (Array.isArray(radar.findings) ? radar.findings : [])
      .filter(f => f && (f.verdict === 'trial' || f.verdict === 'adopt')).length;
    if (worth) push('radar', 'good', 'Radar: ' + worth + ' worth trying', 'radar', radarAt);
  }

  /* email: counts only, never subjects or senders */
  const unread = email ? num(email.unread) : null, wasUnread = emailPrev ? num(emailPrev.unread) : null;
  if (unread !== null && wasUnread !== null && unread > wasUnread) {
    push('email', 'info', (unread - wasUnread) + ' new emails', 'email', now);
  }

  /* youtube: newest row against the newest row at or before lastSeen */
  const yt = (Array.isArray(youtube) ? youtube : [])
    .map(r => ({ r, at: msOf(r && r.ts) }))
    .filter(x => x.at !== null)
    .sort((a, b) => a.at - b.at);
  const newest = yt[yt.length - 1];
  const base = yt.filter(x => x.at <= from).pop();
  if (newest && base) {
    const ds = (num(newest.r.subs) ?? 0) - (num(base.r.subs) ?? 0);
    const dv = (num(newest.r.views) ?? 0) - (num(base.r.views) ?? 0);
    const parts = [];
    if (ds) parts.push((ds > 0 ? '+' : '') + ds + ' subs');
    if (dv) parts.push((dv > 0 ? '+' : '') + dv + ' views');
    if (parts.length) push('youtube', ds > 0 || dv > 0 ? 'good' : 'info', parts.join(', '), 'youtube', newest.at);
  }

  /* tracker updates */
  const jobRows = (Array.isArray(jobs) ? jobs : [])
    .map(j => ({ j, at: msOf(j && j.at) }))
    .filter(x => x.at !== null && x.at > from);
  if (jobRows.length) {
    push('jobs', 'info', jobRows.length + ' tracker updates', 'jobs', Math.max(...jobRows.map(x => x.at)));
  }

  const counts = { bad: 0, warn: 0, good: 0, info: 0 };
  for (const item of items) counts[item.severity]++;
  const sorted = [...items]
    .sort((a, b) => SEV[a.severity] - SEV[b.severity] || Date.parse(b.at) - Date.parse(a.at))
    .filter((item, i, all) => { /* repeated alerts (same text) show once, newest first, with a count */
      const same = all.filter(x => x.severity === item.severity && x.text === item.text);
      if (same[0] !== item) return false;
      item.repeats = same.length;
      return true;
    })
    .slice(0, CAP)
    .map((item, i) => ({ kind: item.kind, severity: item.severity, rank: i + 1, text: item.repeats > 1 ? item.text + ' (x' + item.repeats + ')' : item.text, target: item.target, at: item.at }));

  return {
    since: new Date(from).toISOString(),
    items: sorted,
    allClear: counts.bad === 0 && counts.warn === 0,
    counts
  };
}

module.exports = { sinceItems };
