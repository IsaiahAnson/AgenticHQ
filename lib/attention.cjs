'use strict';
// Attention budget: the one gate every phone push (ntfy) goes through.
//   notify({ source, title, text, priority, key, click }) sends while today's budget lasts
//   (attention.dailyPushes, default 3, per America/New_York day); urgent always sends but counts;
//   low, over-budget and muted (demoted) pushes go to data/attention-digest.jsonl for the 20:00 digest.
//   Every sent push carries a Dismiss button (POST /local/attention/dismiss?key=...). A source whose
//   last 5 pushes were all dismissed is demoted (normal -> low) until `node tools/attention.mjs unmute <source>`.
// Deterministic: no model or API calls, no dependencies.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KIT = path.resolve(__dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const PRIORITIES = new Set(['urgent', 'normal', 'low']);
const DEMOTE_AFTER = 5;
const RECENT_KEEP = 20;

function readConfig() {
  const file = process.env.HQ_CONFIG ? path.resolve(process.env.HQ_CONFIG) : path.join(KIT, 'os-config.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).attention || {}; } catch (_) { return {}; }
}

function settings(opts = {}) {
  const cfg = { ...readConfig(), ...(opts.config || {}) };
  const dir = opts.dir || process.env.HQ_ATTENTION_DIR || path.join(KIT, 'data');
  const hqUrl = String(opts.hqUrl || cfg.hqUrl || 'http://localhost:50000').replace(/\/+$/, '');
  return {
    dir,
    artifactsDir: opts.artifactsDir || path.join(KIT, 'artifacts'),
    budget: Number.isFinite(Number(cfg.dailyPushes)) ? Math.max(0, Number(cfg.dailyPushes)) : 3,
    timeZone: cfg.timeZone || 'America/New_York',
    ntfy: String(opts.ntfy || cfg.ntfy || 'http://localhost:50112').replace(/\/+$/, ''),
    topic: opts.topic || cfg.topic || 'agentic-hq',
    hqUrl,
    dismissBase: String(cfg.dismissBase || hqUrl).replace(/\/+$/, ''),
    now: opts.now === undefined ? Date.now() : Number(opts.now),
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    onEvent: opts.onEvent || defaultEvent,
    files: {
      state: path.join(dir, 'attention-state.json'),
      digest: path.join(dir, 'attention-digest.jsonl'),
      stats: path.join(dir, 'attention-stats.json')
    }
  };
}

function defaultEvent(ev) {
  try { require('./hq-events.cjs').append(ev); } catch (_) { }
}

const oneLine = (value, limit = 300) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
/* a push's click link: http(s) only, so a javascript: or data: URL never reaches ntfy or the digest page */
const httpUrl = value => { const v = oneLine(value, 500); try { return v && ['http:', 'https:'].includes(new URL(v).protocol) ? v : null; } catch (_) { return null; } };
const cleanSource = value =>oneLine(value, 80).toLowerCase().replace(/[^a-z0-9:._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';

// YYYY-MM-DD of `now` in the budget's time zone.
function localDay(now, timeZone = 'America/New_York') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function loadState(s) {
  const state = readJson(s.files.state, {});
  if (!state.keys || typeof state.keys !== 'object') state.keys = {};
  const today = localDay(s.now, s.timeZone);
  if (state.day !== today) { state.day = today; state.sent = 0; }
  state.sent = Number(state.sent) || 0;
  for (const [key, at] of Object.entries(state.keys)) if (!(Number(at) >= s.now - DAY_MS)) delete state.keys[key];
  return state;
}

function loadStats(s) {
  const stats = readJson(s.files.stats, {});
  if (!stats.sources || typeof stats.sources !== 'object') stats.sources = {};
  return stats;
}
function sourceStats(stats, source) {
  const row = stats.sources[source] || (stats.sources[source] = { sent: 0, dismissed: 0, held: 0, muted: false, recent: [] });
  if (!Array.isArray(row.recent)) row.recent = [];
  return row;
}

function keyFor({ source, title, text }) {
  return crypto.createHash('sha256').update([source, title, text].join('\n')).digest('hex').slice(0, 24);
}

function ntfyBody(s, item) {
  const body = {
    topic: s.topic, title: item.title, message: item.text || item.title, tags: ['robot'],
    priority: item.priority === 'urgent' ? 5 : item.priority === 'low' ? 2 : 3,
    actions: [{ action: 'http', label: 'Dismiss', url: `${s.dismissBase}/local/attention/dismiss?key=${encodeURIComponent(item.key)}`, method: 'POST', clear: true }]
  };
  if (item.click) body.click = item.click;
  return body;
}

async function send(s, body) {
  const response = await s.fetchImpl(s.ntfy, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000)
  });
  if (!response || !response.ok) throw new Error(`ntfy returned HTTP ${response && response.status}`);
}

// The gate. Returns { sent, held, reason, key }; reason is sent | duplicate | low | muted | over-budget.
async function notify(input = {}, opts = {}) {
  const s = settings(opts);
  const source = cleanSource(input.source);
  const title = oneLine(input.title, 160) || source;
  const text = oneLine(input.text, 1000);
  let priority = PRIORITIES.has(String(input.priority)) ? String(input.priority) : 'normal';
  const key = oneLine(input.key, 160) || keyFor({ source, title, text });
  const click = httpUrl(input.click);

  const state = loadState(s);
  if (state.keys[key]) return { sent: false, held: false, reason: 'duplicate', key };
  state.keys[key] = s.now;

  const stats = loadStats(s);
  const row = sourceStats(stats, source);
  let reason = null;
  if (priority === 'low') reason = 'low';
  else if (priority === 'normal' && row.muted) { priority = 'low'; reason = 'muted'; }
  else if (priority === 'normal' && state.sent >= s.budget) reason = 'over-budget';

  const item = { ts: new Date(s.now).toISOString(), day: state.day, source, title, text, priority, key, click };
  if (reason) {
    fs.mkdirSync(path.dirname(s.files.digest), { recursive: true });
    fs.appendFileSync(s.files.digest, JSON.stringify({ ...item, reason }) + '\n', 'utf8');
    row.held++;
    writeJson(s.files.state, state);
    writeJson(s.files.stats, stats);
    return { sent: false, held: true, reason, key };
  }

  try { await send(s, ntfyBody(s, item)); }
  catch (error) { delete state.keys[key]; writeJson(s.files.state, state); throw error; }
  state.sent++;
  row.sent++;
  row.recent.push({ key, at: item.ts, dismissed: false });
  row.recent = row.recent.slice(-RECENT_KEEP);
  writeJson(s.files.state, state);
  writeJson(s.files.stats, stats);
  return { sent: true, held: false, reason: 'sent', key, priority };
}

// Phone tapped Dismiss: mark that push dismissed; 5 dismissed in a row demotes its source.
function dismiss(key, opts = {}) {
  const s = settings(opts);
  const stats = loadStats(s);
  for (const [source, row] of Object.entries(stats.sources)) {
    const hit = (row.recent || []).find(r => r.key === key);
    if (!hit) continue;
    if (hit.dismissed) return { ok: true, source, already: true, demoted: false };
    hit.dismissed = true;
    row.dismissed = (Number(row.dismissed) || 0) + 1;
    const last = row.recent.slice(-DEMOTE_AFTER);
    const demoted = !row.muted && last.length >= DEMOTE_AFTER && last.every(r => r.dismissed);
    if (demoted) {
      row.muted = true;
      row.mutedAt = new Date(s.now).toISOString();
      s.onEvent({ type: 'attention.demoted', source: 'attention', severity: 'info', key: `attention.demoted:${source}`,
        summary: `${source} demoted: its last ${DEMOTE_AFTER} pushes were dismissed. Undo: node tools/attention.mjs unmute ${source}`, data: { source } });
    }
    writeJson(s.files.stats, stats);
    return { ok: true, source, demoted };
  }
  return { ok: false, error: 'unknown key' };
}

function unmute(source, opts = {}) {
  const s = settings(opts);
  const stats = loadStats(s);
  const name = cleanSource(source);
  const row = stats.sources[name];
  if (!row) return { ok: false, error: `no such source: ${name}` };
  row.muted = false;
  delete row.mutedAt;
  row.recent = []; // fresh start, so five old dismissals don't demote it again on the next one
  writeJson(s.files.stats, stats);
  return { ok: true, source: name };
}

// Pure: held items -> { count, title, lines, groups }. count is every held push; the same push held again (same source,
// title and text) is one row with repeats, placed at its newest copy.
function buildDigest(items) {
  const groups = new Map(), same = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const item of items) {
    if (!groups.has(item.source)) groups.set(item.source, new Map());
    const rows = groups.get(item.source), key = same(item.title) + '\n' + same(item.text), seen = rows.get(key);
    rows.delete(key);
    rows.set(key, { ...item, repeats: (seen ? seen.repeats : 0) + 1 });
  }
  const lists = [...groups].map(([source, rows]) => [source, [...rows.values()]]), total = lists.reduce((n, [, list]) => n + list.length, 0);
  const lines = lists.map(([source, list]) => `${source} (${list.length}): ${oneLine(list[list.length - 1].title, 80)}${list.length > 1 ? ` +${list.length - 1} more` : ''}`);
  return { count: items.length, title: `HQ today: ${total} item${total === 1 ? '' : 's'}`, lines, groups: lists.map(([source, list]) => ({ source, items: list })) };
}

function heldSince(s, since) {
  let raw = '';
  try { raw = fs.readFileSync(s.files.digest, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const item = JSON.parse(line); if (!since || Date.parse(item.ts) > Date.parse(since)) out.push(item); } catch (_) { }
  }
  return out;
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function reportHtml(day, digest, stats) {
  const muted = Object.entries(stats.sources).filter(([, r]) => r.muted);
  const rows = Object.entries(stats.sources).sort(([a], [b]) => a.localeCompare(b))
    .map(([src, r]) => `<tr><td>${esc(src)}</td><td>${r.sent || 0}</td><td>${r.dismissed || 0}</td><td>${r.held || 0}</td><td>${r.muted ? 'muted' : ''}</td></tr>`).join('');
  const groups = digest.groups.map(g => `<section><h2>${esc(g.source)} <span>${g.items.length}</span></h2><ul>${g.items.map(i =>
    `<li><b>${esc(i.title)}</b>${i.text && i.text !== i.title ? ` — ${esc(i.text)}` : ''} <small>${i.repeats > 1 ? `x${i.repeats} · ` : ''}${esc(i.reason)} ·${esc(new Date(i.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }))}${httpUrl(i.click) ? ` · <a href="${esc(httpUrl(i.click))}">open</a>` : ''}</small></li>`).join('')}</ul></section>`).join('');
  const mutedHtml = muted.length ? `<section><h2>Muted sources</h2><ul>${muted.map(([src, r]) => {
    const last = (r.recent || []).slice(-DEMOTE_AFTER);
    return `<li>muted: <b>${esc(src)}</b>, dismissed ${last.filter(x => x.dismissed).length} of ${last.length || DEMOTE_AFTER} <code>node tools/attention.mjs unmute ${esc(src)}</code></li>`;
  }).join('')}</ul></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Attention Digest ${esc(day)}</title><style>
:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--acc:#2dd4bf}
@media (prefers-color-scheme: light){:root{--bg:#f6f8fa;--fg:#1f2328;--mut:#59636e;--line:#d0d7de;--acc:#0f766e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 6px;color:var(--acc)}h2 span{color:var(--mut);font-weight:400}
p.sub,small{color:var(--mut)}ul{padding-left:18px;margin:0}li{margin:4px 0}code{font-size:13px;padding:1px 5px;border:1px solid var(--line);border-radius:4px}
table{border-collapse:collapse;width:100%;margin-top:6px}td,th{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left}a{color:var(--acc)}
</style></head><body><main><h1>${esc(digest.title)}</h1><p class="sub">${esc(day)} · held by the attention budget instead of buzzing your phone</p>
${groups}${mutedHtml}<section><h2>Per source</h2><table><tr><th>source</th><th>sent</th><th>dismissed</th><th>held</th><th></th></tr>${rows}</table></section>
</main></body></html>`;
}

// 20:00 digest: one push summarising everything held since the last digest; skipped when nothing was held.
async function runDigest(opts = {}) {
  const s = settings(opts);
  const state = readJson(s.files.state, {});
  const items = heldSince(s, state.digestedThrough);
  const day = localDay(s.now, s.timeZone);
  if (!items.length) return { skipped: true, reason: 'nothing held', day };
  const digest = buildDigest(items);
  const slug = `attention-digest-${day}`;
  const click = `${s.hqUrl}/artifacts/${slug}.html`;
  const message = digest.lines.slice(0, 12).join('\n') + (digest.lines.length > 12 ? `\n+${digest.lines.length - 12} more sources` : '');
  const body = { topic: s.topic, title: digest.title, message, tags: ['inbox_tray'], priority: 3, click };
  if (opts.dryRun) return { skipped: false, dryRun: true, day, digest, push: body };

  const stats = loadStats(s);
  fs.mkdirSync(s.artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(s.artifactsDir, `${slug}.html`), reportHtml(day, digest, stats), 'utf8');
  writeJson(path.join(s.artifactsDir, `${slug}.json`), {
    title: `Attention digest ${day}`, icon: 'mail', kind: 'report', created: new Date(s.now).toISOString(),
    note: `${digest.count} held pushes from ${digest.groups.length} source${digest.groups.length === 1 ? '' : 's'}`,
    svg: '<rect x="8" y="12" width="32" height="24" rx="3"/><path d="M8 14l16 12 16-12"/><circle cx="38" cy="12" r="5"/>'
  });
  await send(s, body); // the digest itself never counts toward the daily budget
  const fresh = readJson(s.files.state, {});
  fresh.digestedThrough = items[items.length - 1].ts;
  writeJson(s.files.state, fresh);
  return { skipped: false, day, count: digest.count, report: `${slug}.html` };
}

function status(opts = {}) {
  const s = settings(opts);
  const state = loadState(s);
  return { day: state.day, sent: state.sent, budget: s.budget, held: heldSince(s, readJson(s.files.state, {}).digestedThrough).length, sources: loadStats(s).sources };
}

module.exports = { notify, dismiss, unmute, buildDigest, runDigest, status, localDay, keyFor };
