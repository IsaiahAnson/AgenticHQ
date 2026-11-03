'use strict';
/* USAGE FORECAST (P4): will a usage meter run out before it resets?
   Pure: the caller passes the hourly usage history in. For every agent+label in the newest row we keep
   the readings from the same reset window (resetsAt within 60 s), fit a least-squares line of used over
   hours, project it to the reset, and say over / tight / ok in one 12-hour line. No file or network reads.
   Tested in test/usage-forecast.test.cjs. */
const HQ = require('../assets/time12.js');

const HOUR = 36e5;
const WINDOW_MS = 60e3;
const MIN_SPAN_MS = 30 * 60e3;
const SPARK_MAX = 24;
const CAP = 999;
const NAMES = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot' };
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const RANK = { over: 0, tight: 1, ok: 2 };

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const msOf = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = /^\d+$/.test(v.trim()) ? +v.trim() : Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
const sameDay = (a, b) => dayKey(a) === dayKey(b);
/* fmt: a clock function, or { time }, or nothing (assets/time12.js) */
const clockOf = fmt => typeof fmt === 'function' ? fmt
  : fmt && typeof fmt.time === 'function' ? v => fmt.time(v) : v => HQ.time(v);
const stamp = (t, now, clock) => sameDay(t, now) ? clock(t) : WEEKDAY.format(new Date(t)) + ' ' + clock(t);

/* readings for one agent+label inside the newest resetsAt window, oldest first */
function windowReadings(rows, agent, label, resetsAt) {
  const out = [];
  for (const row of rows) {
    const list = row.meters[agent];
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!m || m.label !== label) continue;
      const used = num(m.used);
      if (used === null) continue;
      const reset = msOf(m.resetsAt);
      const same = resetsAt === null ? reset === null : reset !== null && Math.abs(reset - resetsAt) <= WINDOW_MS;
      if (same) out.push({ t: row.t, used });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/* least-squares slope of used over hours; null with < 2 points or < 30 min of history; never negative */
function rateOf(points) {
  if (points.length < 2) return null;
  if (points[points.length - 1].t - points[0].t < MIN_SPAN_MS) return null;
  const base = points[0].t;
  const xs = points.map(p => (p.t - base) / HOUR);
  const ys = points.map(p => p.used);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cross = 0, spread = 0;
  for (let i = 0; i < points.length; i++) {
    cross += (xs[i] - mx) * (ys[i] - my);
    spread += (xs[i] - mx) ** 2;
  }
  if (!(spread > 0)) return null;
  const slope = cross / spread;
  return slope < 0 ? 0 : slope;
}

function meterRow({ agent, label, used, resetsAt, rows, now, clock }) {
  const points = windowReadings(rows, agent, label, resetsAt);
  const rate = rateOf(points);
  const hours = resetsAt === null ? 0 : Math.max(0, (resetsAt - now) / HOUR);
  const projectedAtReset = rate === null
    ? Math.min(CAP, Math.round(used))
    : Math.min(CAP, Math.round(used + rate * hours));

  let hitAt = null;
  if (resetsAt !== null && resetsAt > now) {
    if (used >= 100) hitAt = now;
    else if (rate !== null && rate > 0) {
      const at = now + ((100 - used) / rate) * HOUR;
      if (at < resetsAt) hitAt = Math.round(at);
    }
  }

  const verdict = projectedAtReset >= 100 ? 'over' : projectedAtReset >= 85 ? 'tight' : 'ok';
  const name = NAMES[agent] || agent;
  const head = name + ' ' + label + ': ' + Math.round(used) + '% used';
  let text;
  if (hitAt !== null && verdict === 'over') {
    text = head + ', runs out about ' + stamp(hitAt, now, clock) + (resetsAt === null ? '' : ' (resets ' + stamp(resetsAt, now, clock) + ')');
  } else if (rate === null) {
    text = head + ', not enough readings yet';
  } else if (resetsAt === null) {
    text = head + ', on pace for ' + projectedAtReset + '%';
  } else {
    text = head + ', on pace for ' + projectedAtReset + '% by ' + stamp(resetsAt, now, clock) + ' reset';
  }

  return {
    agent, label, used, resetsAt,
    ratePerHour: rate === null ? null : Math.round(rate * 100) / 100,
    projectedAtReset, hitAt, verdict, text,
    spark: points.slice(-SPARK_MAX).map(p => p.used)
  };
}

function forecast(history, { now = Date.now(), fmt } = {}) {
  const clock = clockOf(fmt);
  const rows = [];
  for (const row of Array.isArray(history) ? history : []) {
    if (!row || typeof row !== 'object') continue;
    const t = msOf(row.ts);
    if (t === null || !row.meters || typeof row.meters !== 'object') continue;
    rows.push({ t, meters: row.meters });
  }
  rows.sort((a, b) => a.t - b.t);
  const newest = rows[rows.length - 1];
  const meters = [];
  if (newest) {
    for (const agent of Object.keys(newest.meters)) {
      const list = newest.meters[agent];
      if (!Array.isArray(list)) continue;
      for (const m of list) {
        if (!m || typeof m.label !== 'string' || !m.label) continue;
        const used = num(m.used);
        if (used === null) continue;
        meters.push(meterRow({ agent, label: m.label, used, resetsAt: msOf(m.resetsAt), rows, now, clock }));
      }
    }
  }
  meters.sort((a, b) => RANK[a.verdict] - RANK[b.verdict]
    || b.projectedAtReset - a.projectedAtReset
    || a.agent.localeCompare(b.agent)
    || a.label.localeCompare(b.label));
  return { generatedAt: new Date(now).toISOString(), meters };
}

module.exports = { forecast, rateOf, windowReadings };
