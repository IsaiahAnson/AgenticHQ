// The Agent monitor ball (local addition): Claude Code, Codex and Copilot side by side.
// Sessions in the last 7 and 30 days, tokens as each CLI logged them, what is active now, the
// latest sessions, and skills deck runs per agent. Reads local files only, calls no model.
// Writes artifacts/agent-monitor.html + .json (a ball on the ring) and data/agents.json.
// Run: node refresh/agents.mjs   (also part of refresh/run.mjs, and the server reruns it every 5 minutes)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url)), KIT = path.resolve(HERE, '..');
const T = require('../assets/time12.js');
const { allSessions } = require('./sources/agents.cjs');
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAY = 864e5, now = Date.now(), ACTIVE = 15 * 60e3, t0 = Date.now();
const fmt = n => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const ago = ms => { const m = Math.round((now - ms) / 60e3); return m < 1 ? 'now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };

const sessions = allSessions(30);
/* chat titles and live status from Agent HQ, when it runs (http://127.0.0.1:4747, read-only) */
const hq = await fetch('http://127.0.0.1:4747/api/state', { signal: AbortSignal.timeout(4000) }).then(r => r.json()).catch(() => null);
const hqById = new Map(((hq && hq.sessions) || []).map(x => [x.id, x]));
for (const s of sessions) { const h = hqById.get(s.id); if (h) { s.title = h.title || ''; s.status = h.status || ''; if (!s.model && h.model) s.model = h.model; } }
const shortModel = m => { m = String(m || '').toLowerCase(); const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m); return c ? `${c[1]} ${c[2]}.${c[3]}` : m.replace(/-/g, ' ').replace(/^gpt (\d+)/, 'gpt-$1'); };
const modelCol = m => /opus/.test(m) ? '#9a66e0' : /sonnet/.test(m) ? '#3f8fd4' : /haiku/.test(m) ? '#2aa88a' : /fable/.test(m) ? '#ff6b1a' : /gpt|codex/.test(m) ? '#18c5d9' : '#c0ca33';
const badge = m => m && m !== '—' ? `<span class="tag" style="--c:${modelCol(String(m).toLowerCase())}" title="${esc(m)}">${esc(shortModel(m))}</span>` : '—';
const usage = readJSON(path.join(KIT, 'data', 'arms-usage.json'), null);
const runs = readJSON(path.join(KIT, 'data', 'runs.json'), []);
const AGENTS = [
  { key: 'claude', label: 'Claude Code', color: '#ff6b1a' },
  { key: 'codex', label: 'Codex', color: '#18c5d9' },
  { key: 'copilot', label: 'Copilot', color: '#9a66e0' },
];
const summary = AGENTS.map(a => {
  const mine = sessions.filter(s => s.agent === a.key), w7 = mine.filter(s => s.last >= now - 7 * DAY);
  const sum = list => list.some(s => s.tokens != null) ? list.reduce((t, s) => t + (s.tokens || 0), 0) : null;
  let tok7 = sum(w7), tok30 = sum(mine);
  if (a.key === 'claude' && usage && usage.totals) { tok7 = usage.totals['7']?.tok ?? null; tok30 = usage.totals['30']?.tok ?? null; }
  const premium = a.key === 'copilot' ? mine.reduce((t, s) => t + (s.premium || 0), 0) : null;
  const active = mine.filter(s => s.live || now - s.last < ACTIVE).length;
  const deck = runs.filter(r => (r.agent || 'claude') === a.key);
  return { ...a, s7: w7.length, s30: mine.length, tok7, tok30, premium, active, last: mine[0] ? mine[0].last : null, deckRuns: deck.length };
});
fs.writeFileSync(path.join(KIT, 'data', 'agents.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary, sessions: sessions.slice(0, 200) }, null, 1));

const card = a => `<div class="card" style="--c:${a.color}"><div class="kick">${esc(a.label)}</div>
<div class="big">${a.active ? `<span class="dot"></span>${a.active} active` : 'idle'}</div>
<div class="grid"><div>Sessions 7d<b>${a.s7}</b></div><div>Sessions 30d<b>${a.s30}</b></div><div>Tokens 7d<b>${fmt(a.tok7)}</b></div><div>Tokens 30d<b>${fmt(a.tok30)}</b></div>
${a.premium != null ? `<div>Premium req 30d<b>${a.premium}</b></div>` : ''}<div>Deck runs<b>${a.deckRuns}</b></div><div>Last seen<b>${a.last ? ago(a.last) : '—'}</b></div></div></div>`;
const colorOf = k => (AGENTS.find(a => a.key === k) || {}).color || '#888';
const row = s => `<tr><td><span class="tag" style="--c:${colorOf(s.agent)}">${esc(s.agent)}</span>${s.live || now - s.last < ACTIVE ? ' <span class="dot"></span>' : ''}</td><td>${s.title ? esc(s.title) + (s.status && s.status !== 'idle' ? ' <small>' + esc(s.status) + '</small>' : '') : '<span style="opacity:.5">—</span>'}</td><td>${esc(s.where || '—')}</td><td>${badge(s.model)}</td><td class="n">${fmt(s.tokens)}</td><td>${esc(T.dateTime(s.start))}</td><td>${ago(s.last)}</td></tr>`;
const runRow = r => `<tr><td><span class="tag" style="--c:${colorOf(r.agent || 'claude')}">${esc(r.agent || 'claude')}</span></td><td>/${esc(r.id)}</td><td>${badge(r.model)}</td><td class="n">${esc(r.seconds)}s</td><td>${r.exit === 0 ? 'ok' : 'exit ' + esc(r.exit)}</td><td>${r.report ? `<a href="${esc(r.report)}">report</a>` : ''}</td></tr>`;

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent monitor</title>
<style>
  :root { --paper:#f2efe8; --ink:#1c1a16; --line:#d6d0c2; --mute:#8d8775; --card:#fbf9f4; }
  @media (prefers-color-scheme: dark) { :root { --paper:#141311; --ink:#ece6d8; --line:#33302a; --mute:#8d8775; --card:#1c1a17; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--paper); color:var(--ink); font:400 14px/1.5 Outfit,system-ui,sans-serif; padding:40px 16px; }
  .wrap { max-width:1000px; margin:0 auto; } h1 { font-size:28px; margin:4px 0 2px; letter-spacing:-.5px; } h2 { font-size:15px; letter-spacing:2px; text-transform:uppercase; color:var(--mute); margin:34px 0 10px; font-weight:500; }
  .kick { font-size:10px; letter-spacing:3px; text-transform:uppercase; color:var(--mute); } .sub { color:var(--mute); margin:0 0 22px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-top:3px solid var(--c); border-radius:10px; padding:16px 18px; }
  .card .kick { color:var(--c); font-weight:600; } .big { font-size:22px; font-weight:600; margin:4px 0 12px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; } .grid div { font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:var(--mute); }
  .grid b { display:block; font-size:17px; letter-spacing:0; text-transform:none; color:var(--ink); font-variant-numeric:tabular-nums; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#2bd46b; box-shadow:0 0 0 3px #2bd46b33; vertical-align:middle; margin-right:6px; }
  .scroll { overflow-x:auto; } table { width:100%; border-collapse:collapse; min-width:620px; }
  th { text-align:left; font-size:10px; letter-spacing:2px; text-transform:uppercase; color:var(--mute); font-weight:500; padding:0 10px 8px 0; border-bottom:1px solid var(--line); }
  td { padding:8px 10px 8px 0; border-bottom:1px solid var(--line); vertical-align:top; } td.n { font-variant-numeric:tabular-nums; }
  .tag { display:inline-block; font-size:11px; padding:1px 8px; border-radius:20px; border:1px solid var(--c); color:var(--c); }
  a { color:#ff6b1a; } footer { margin-top:30px; font-size:11px; color:var(--mute); }
</style>
<div class="wrap"><div class="kick">Agentic HQ · local</div><h1>Agent monitor</h1>
<p class="sub">Claude Code, Codex and Copilot on this PC. Updated ${esc(T.dateTime(new Date(), { year: true }))}. Active means a session wrote in the last 15 minutes (or Copilot holds its lock).</p>
<div class="cards">${summary.map(card).join('')}</div>
<h2>Latest sessions</h2><div class="scroll"><table><tr><th>Agent</th><th>Chat</th><th>Folder</th><th>Model</th><th>Tokens</th><th>Started</th><th>Last write</th></tr>${sessions.slice(0, 40).map(row).join('') || '<tr><td colspan="7">No sessions in the last 30 days.</td></tr>'}</table></div>
<h2>Skills deck runs</h2><div class="scroll"><table><tr><th>Agent</th><th>Card</th><th>Model</th><th>Time</th><th>Result</th><th></th></tr>${runs.slice(0, 20).map(runRow).join('') || '<tr><td colspan="6">No deck runs yet.</td></tr>'}</table></div>
<footer>Tokens are as each CLI logged them (Codex counts cached input). Claude tokens come from the OS usage scan. Nothing here is sent anywhere.</footer></div></html>`;
fs.writeFileSync(path.join(KIT, 'artifacts', 'agent-monitor.html'), html);
const sideFile = path.join(KIT, 'artifacts', 'agent-monitor.json');
const created = readJSON(sideFile, {}).created || new Date().toISOString();
fs.writeFileSync(sideFile, JSON.stringify({ title: 'Agent monitor', icon: 'chart', kind: 'report', created, note: 'Claude Code, Codex and Copilot sessions, tokens and deck runs', svg: '<circle cx="14" cy="24" r="6"/><circle cx="34" cy="14" r="6"/><circle cx="34" cy="34" r="6"/><path d="M20 24h6M26 24l3-6M26 24l3 6"/>' }, null, 2));
console.log(JSON.stringify({ sessions: sessions.length, summary: summary.map(s => `${s.key}:${s.s30}`), ms: Date.now() - t0 }));
