'use strict';
/* The usage gate's reading of one meter window, shared by tools/usage-check.mjs (agents' stop rule) and
   lib/bench.cjs (WORKER BENCH capacity), so both say the same thing about the same /api/stats meter. */

const WINDOWS = { claude: '5h', codex: '5h', copilot: 'credits' };
const UNMETERED = ['opencode', 'deepseek', 'kilo'];

/* verdict: 'ok', 'low' (used >= threshold: start nothing new), 'stale' (reading over 30 min old), 'unknown' (no window) */
function meterVerdict(meter, label, { threshold = 90, now = Date.now() } = {}) {
  const win = ((meter && meter.windows) || []).find(w => w.label === label);
  if (!win || !Number.isFinite(win.used)) return { window: label, used: null, verdict: 'unknown', estimated: false, stale: false, idle: false, resetsAt: null, ageMinutes: null };
  const ageMinutes = Number.isFinite(meter.t) ? Math.round((now - meter.t) / 60000) : null;
  const idle = meter.idleSince === true;
  const stale = win.rolledOver !== true && !idle && (meter.stale === true || (ageMinutes !== null && ageMinutes > 30));   // a passed reset time or no later activity makes the reading trustworthy
  const used = Math.round(win.used * 10) / 10;
  return { window: win.label, used, verdict: used >= threshold ? 'low' : stale ? 'stale' : 'ok', estimated: win.estimated === true, stale, idle,
    resetsAt: Number.isFinite(win.resetsAt) ? win.resetsAt : null, ageMinutes };
}

module.exports = { WINDOWS, UNMETERED, meterVerdict };
