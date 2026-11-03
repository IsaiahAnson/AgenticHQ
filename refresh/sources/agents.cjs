/* Sessions of every coding agent on this machine (local addition), for the Agent monitor ball.
   Reads only what each CLI already keeps in its own folder, and keeps only times, folder names,
   models and token counts, never prompts or replies.
   - Claude Code: ~/.claude/projects/<project>/<session>.jsonl
   - Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (session_meta, turn_context, token_count)
   - Copilot CLI: ~/.copilot/session-state/<id>/events.jsonl (session.start, session.usage_record) */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// Claude Code names a project folder after its path with every other character as '-' (C:\Users\sam -> C--Users-sam).
const HOME_KEY = new RegExp('^' + HOME.replace(/[^A-Za-z0-9]/g, '-') + '-?');
const DAY = 864e5;
const tail = p => String(p || '').split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
/* session logs can be hundreds of MB: read them in 1 MB chunks, never whole */
function eachLine(file, fn) {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
  let rest = '', n;
  try {
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const parts = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = parts.pop();
      if (rest.length > 8 << 20) rest = '';            // one giant line we do not need
      for (const l of parts) fn(l);
    }
    if (rest) fn(rest);
  } finally { fs.closeSync(fd); }
}
function slice(file, size, fromEnd) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, fs.fstatSync(fd).size), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? fs.fstatSync(fd).size - len : 0);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function filesUnder(dir, test, depth = 4) {
  const out = [];
  (function rec(d, n) {
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && n > 0) rec(p, n - 1);
      else if (e.isFile() && test(e.name)) out.push(p);
    }
  })(dir, depth);
  return out;
}
const fresh = (file, cutoff) => { try { const st = fs.statSync(file); return st.mtimeMs >= cutoff ? st : null; } catch { return null; } };

function claude(cutoff) {
  const root = path.join(HOME, '.claude', 'projects');
  return filesUnder(root, n => n.endsWith('.jsonl'), 1).map(f => {
    const st = fresh(f, cutoff); if (!st) return null;
    const head = /"timestamp":"([^"]+)"/.exec(slice(f, 65536, false));
    const models = [...slice(f, 262144, true).matchAll(/"model":"(claude-[^"]+)"/g)];
    const start = head ? Date.parse(head[1]) : 0, model = models.length ? models[models.length - 1][1] : '';
    return { agent: 'claude', id: path.basename(f, '.jsonl'), where: (w => /AppData\/Roaming\/Claude\/scratch/.test(w) ? 'scratch session' : w)(path.basename(path.dirname(f)).replace(HOME_KEY, '~/').replace(/-/g, '/')), start: start || st.mtimeMs, last: st.mtimeMs, model, tokens: null };
  }).filter(Boolean);
}

function codex(cutoff) {
  const root = path.join(HOME, '.codex', 'sessions');
  return filesUnder(root, n => n.endsWith('.jsonl'), 4).map(f => {
    const st = fresh(f, cutoff); if (!st) return null;
    const s = { agent: 'codex', id: path.basename(f, '.jsonl').slice(-36), where: '', start: 0, last: st.mtimeMs, model: '', tokens: 0 };
    eachLine(f, l => {
      if (l.includes('"type":"session_meta"')) { try { const p = JSON.parse(l).payload || {}; s.start = Date.parse(p.timestamp) || 0; s.where = tail(p.cwd); } catch { } }
      else if (l.includes('"type":"turn_context"')) { const m = /"model":"([^"]+)"/.exec(l); if (m) s.model = m[1]; }
      else if (l.includes('"total_token_usage"')) { const m = /"total_token_usage":\{[^}]*"total_tokens":(\d+)/.exec(l); if (m) s.tokens = +m[1]; }
    });
    s.start = s.start || st.mtimeMs;
    return s;
  }).filter(Boolean);
}

function copilot(cutoff) {
  const root = path.join(HOME, '.copilot', 'session-state');
  let dirs; try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()); } catch { return []; }
  return dirs.map(e => {
    const dir = path.join(root, e.name), f = path.join(dir, 'events.jsonl');
    const st = fresh(f, cutoff); if (!st) return null;
    const s = { agent: 'copilot', id: e.name, where: '', start: 0, last: st.mtimeMs, model: '', tokens: 0, premium: null };
    let live = false; try { live = fs.readdirSync(dir).some(n => /^inuse\..*\.lock$/.test(n)); } catch { }
    s.live = live && Date.now() - st.mtimeMs < 2 * 3600e3;   // crashed sessions leave stale locks
    eachLine(f, l => {
      if (l.includes('"type":"session.start"')) { try { const d = JSON.parse(l).data || {}; s.start = Date.parse(d.startTime) || 0; s.where = tail(d.context && d.context.cwd); } catch { } }
      else if (l.includes('"type":"session.usage_record"')) { try { const u = (JSON.parse(l).data || {}).usage || {}; s.tokens += (u.inputTokens || 0) + (u.outputTokens || 0); if (u.model) s.model = u.model; } catch { } }
      else if (l.includes('"type":"session.usage_checkpoint"')) { const m = /"totalPremiumRequests":(\d+)/.exec(l); if (m) s.premium = +m[1]; }
    });
    s.start = s.start || st.mtimeMs;
    return s;
  }).filter(Boolean);
}

function allSessions(days = 30) {
  const cutoff = Date.now() - days * DAY, out = [];
  for (const read of [claude, codex, copilot]) { try { out.push(...read(cutoff)); } catch (e) { console.error('agents reader:', e.message); } }
  return out.sort((a, b) => b.last - a.last);
}

module.exports = { allSessions };
