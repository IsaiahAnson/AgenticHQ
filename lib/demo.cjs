'use strict';
/* DEMO MODE (HQ_DEMO=1; `npm run demo` starts one in a sandbox copy, tools/demo.mjs). The feeds answer from
   demo/fixtures/ instead of real sources, and nothing is written:
   - GET /api/<a>/<b> reads demo/fixtures/<a>.<b>.json, or a variant <a>.<b>@<key>=<value>[&<key>=<value>].json
     whose pairs all match the query (the one with the most pairs wins). An /api/ path with no fixture is a 404,
     except REAL below (the ring pages are real files in the sandbox; add-ons are off).
   - GET /data/<file> reads demo/fixtures/data/<file> when there is one.
   - Every POST is refused. The Second Brain map, its search and file reads stay real: they scan the demo workspace.
   String values like "@iso:-2h15m" are time tokens, resolved on every answer so the demo always looks current. */
const fs = require('fs');
const path = require('path');

const on = (env = process.env) => env.HQ_DEMO === '1';
const REAL = new Set(['/api/artifacts', '/api/addons']);

/* "@<fmt>:<spec>": fmt is iso, ms, s (epoch numbers), date (YYYY-MM-DD) or hm (HH:MM), both local. spec is one
   sign for the whole duration, then terms Nd Nh Nm Ns (or 0 for now), then an optional @HH:MM that sets the local
   clock on that day: "@iso:-2h15m" is 2 h 15 min ago, "@ms:-1d@09:00" yesterday at 9 AM. */
const TOKEN = /^@(iso|ms|s|date|hm):([+-]?)((?:\d+[dhms])*|0)?(?:@(\d{1,2}):(\d{2}))?$/;
const UNIT = { h: 3600e3, m: 60e3, s: 1e3 };
const pad = n => String(n).padStart(2, '0');
function tokenValue(text, now = new Date()) {
  const m = TOKEN.exec(text);
  if (!m) return text;
  const [, fmt, sign, terms = '', hh, mm] = m;
  const k = sign === '-' ? -1 : 1, t = new Date(now);
  for (const [, n, unit] of terms.matchAll(/(\d+)([dhms])/g)) {
    if (unit === 'd') t.setDate(t.getDate() + k * Number(n));   /* calendar days, so @HH:MM stays right across a clock change */
    else t.setTime(t.getTime() + k * Number(n) * UNIT[unit]);
  }
  if (hh !== undefined) t.setHours(Number(hh), Number(mm), 0, 0);
  if (fmt === 'iso') return t.toISOString();
  if (fmt === 'ms') return t.getTime();
  if (fmt === 's') return Math.floor(t.getTime() / 1000);
  if (fmt === 'date') return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
function resolve(value, now = new Date()) {
  if (typeof value === 'string') return value[0] === '@' ? tokenValue(value, now) : value;
  if (Array.isArray(value)) return value.map(v => resolve(v, now));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, now)]));
  return value;
}
/* a /data/*.js fixture: tokens sit inside quotes; ms and s become bare numbers */
function resolveScript(text, now = new Date()) {
  return text.replace(/(["'])(@(?:iso|ms|s|date|hm):[^"'\s]*)\1/g, (all, quote, token) => {
    const v = tokenValue(token, now);
    return v === token ? all : typeof v === 'number' ? String(v) : quote + v + quote;
  });
}

const NAME = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/i;
const decode = s => { try { return decodeURIComponent(s); } catch (_) { return null; } };
/* the fixture file for one API path and query, or null */
function fixtureFile(dir, p2, query = new URLSearchParams()) {
  const name = p2.replace(/^\/api\//, '').replace(/\/+$/, '').split('/').join('.');
  if (!NAME.test(name)) return null;
  let files; try { files = fs.readdirSync(dir); } catch (_) { return null; }
  let best = null, most = 0;
  for (const f of files) {
    if (!f.startsWith(name + '@') || !f.endsWith('.json')) continue;
    const pairs = f.slice(name.length + 1, -5).split('&').map(pair => pair.split('=').map(decode));
    if (pairs.every(([k, v = '']) => k !== null && v !== null && query.get(k) === v) && pairs.length > most) { best = f; most = pairs.length; }
  }
  if (best) return path.join(dir, best);
  return files.includes(name + '.json') ? path.join(dir, name + '.json') : null;
}

function create({ kit, dir = path.join(kit, 'demo', 'fixtures'), sendJson, sendScript }) {
  const read = file => resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  /* one feed's fixture, resolved now (null when the demo has none) */
  function feed(p2, query) { const f = fixtureFile(dir, p2, query); return f ? read(f) : null; }

  /* answers the request and returns true, or returns false so the real route answers it */
  const done = (...args) => { sendJson(...args); return true; };
  async function handle(req, res, { p2, u, post }) {
    if (post) return done(res, { error: 'The demo is read-only.' }, 403);
    if (p2.startsWith('/data/')) {
      const rel = decode(p2.slice('/data/'.length));
      if (!rel || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|json)$/.test(rel)) return false;
      const f = path.join(dir, 'data', rel);
      if (!fs.existsSync(f)) return false;
      const text = fs.readFileSync(f, 'utf8');
      if (rel.endsWith('.js')) sendScript(res, resolveScript(text));
      else sendJson(res, resolve(JSON.parse(text)));
      return true;
    }
    if (!p2.startsWith('/api/') || REAL.has(p2)) return false;
    const f = fixtureFile(dir, p2, u.searchParams);
    return f ? done(res, read(f)) : done(res, { error: 'not in the demo' }, 404);
  }
  return { feed, handle };
}

module.exports = { on, create, tokenValue, resolve, resolveScript, fixtureFile };
