'use strict';
/* ActivityWatch reader (P6 week facts): hours per app for the last N days from the local aw-server.
   Two calls: GET /api/0/buckets/ to find the window and AFK buckets, POST /api/0/query/ with the standard
   AQL that intersects window events with "not-afk" time. Only app names leave this module, never window
   titles. Fails closed: every problem is { ok: false, reason } and nothing throws. No model calls. */
const DAY = 864e5;
const TIMEOUT_MS = 5000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const round1 = value => Number(Number(value || 0).toFixed(1));

/* app names only, case-insensitive, in match order */
function categoryOf(app) {
  const name = String(app == null ? '' : app).toLowerCase();
  if (/reason|ableton|fl ?studio|fl64|bitwig|reaper|cubase|studio one/.test(name)) return 'music';
  if (/code|cursor|devenv|windowsterminal|powershell|pwsh|wezterm|orca/.test(name)) return 'code';
  if (/msedge|chrome|firefox|brave/.test(name)) return 'browser';
  return 'other';
}

/* only the machine this runs on: nothing but localhost may be queried */
function localRoot(value) {
  const url = new URL(String(value || '').trim() || 'http://localhost:5600');
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error('ActivityWatch base must be localhost');
  return url.origin;
}

async function requestJson(fetch, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response || response.ok === false) throw new Error(`HTTP ${(response && response.status) || 0}`);
    if (typeof response.json !== 'function') throw new Error('ActivityWatch returned no JSON');
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* the buckets payload is an object keyed by bucket id; tolerate an array too */
function bucketList(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const entries = Array.isArray(payload) ? payload.map(bucket => [bucket && bucket.id, bucket]) : Object.entries(payload);
  const rows = [];
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const id = typeof value.id === 'string' && value.id ? value.id : typeof key === 'string' ? key : '';
    if (!id) continue;
    rows.push({ ...value, id });
  }
  return rows;
}

const updated = bucket => { const t = Date.parse(bucket.last_updated || ''); return Number.isFinite(t) ? t : 0; };

/* newest window bucket that has an AFK bucket on the same machine: an aw-server may hold other hosts'
   buckets, and intersecting two machines' data would invent hours */
function pickPair(rows) {
  const windows = rows.filter(bucket => bucket.type === 'currentwindow').sort((a, b) => updated(b) - updated(a));
  if (!windows.length) throw new Error('ActivityWatch has no window bucket');
  const afks = rows.filter(bucket => bucket.type === 'afkstatus');
  const rank = (afk, host) => (!afk.hostname ? 1 : host && afk.hostname === host ? 2 : 0);
  for (const windowBucket of windows) {
    const partner = afks
      .filter(afk => rank(afk, windowBucket.hostname) > 0 || !windowBucket.hostname)
      .sort((a, b) => rank(b, windowBucket.hostname) - rank(a, windowBucket.hostname) || updated(b) - updated(a))[0];
    if (partner) return { windowBucket, afkBucket: partner };
  }
  throw new Error('ActivityWatch has no afk bucket');
}

/* the query result is a list per RETURN; walk it and keep the event objects */
function eventsOf(result) {
  const found = [];
  const visit = value => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (value && typeof value === 'object' && value.data && typeof value.data === 'object') found.push(value);
  };
  visit(result);
  return found;
}

function aql(windowId, afkId) {
  return [
    `afk = flood(query_bucket("${afkId}"));`,
    'afk = filter_keyvals(afk, "status", ["not-afk"]);',
    `w = flood(query_bucket("${windowId}"));`,
    'w = filter_period_intersect(w, afk);',
    'RETURN = sort_by_duration(merge_events_by_keys(w, ["app"]));'
  ];
}

async function hoursByApp({ base = 'http://localhost:5600', days = 7, now = Date.now(), fetch = globalThis.fetch } = {}) {
  const to = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 7;
  const from = to - span * DAY;
  try {
    if (typeof fetch !== 'function') throw new Error('fetch is unavailable');
    const root = localRoot(base);
    const rows = bucketList(await requestJson(fetch, `${root}/api/0/buckets/`, { headers: { accept: 'application/json' } }));
    if (!rows.length) throw new Error('ActivityWatch has no buckets');
    const { windowBucket, afkBucket } = pickPair(rows);

    const body = {
      timeperiods: [`${new Date(from).toISOString()}/${new Date(to).toISOString()}`],
      query: aql(windowBucket.id, afkBucket.id)
    };
    const result = await requestJson(fetch, `${root}/api/0/query/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });

    const seconds = new Map();
    for (const event of eventsOf(result)) {
      const app = event.data.app;
      const duration = Number(event.duration);
      if (typeof app !== 'string' || !app.trim()) continue;
      if (!Number.isFinite(duration) || duration <= 0) continue;
      seconds.set(app.trim(), (seconds.get(app.trim()) || 0) + duration);
    }
    const byCategory = { music: 0, code: 0, browser: 0, other: 0 };
    const apps = [];
    let total = 0;
    for (const [app, sec] of seconds) {
      const category = categoryOf(app);
      byCategory[category] += sec;
      total += sec;
      apps.push({ app, seconds: sec, hours: round1(sec / 3600), category });
    }
    apps.sort((a, b) => b.seconds - a.seconds || a.app.localeCompare(b.app));

    return {
      ok: true,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      totalHours: round1(total / 3600),
      byCategory: {
        music: round1(byCategory.music / 3600),
        code: round1(byCategory.code / 3600),
        browser: round1(byCategory.browser / 3600),
        other: round1(byCategory.other / 3600)
      },
      topApps: apps.slice(0, 8).map(({ app, hours, category }) => ({ app, hours, category }))
    };
  } catch (error) {
    return { ok: false, reason: String((error && error.message) || error || 'ActivityWatch unavailable') };
  }
}

module.exports = { hoursByApp, categoryOf };
