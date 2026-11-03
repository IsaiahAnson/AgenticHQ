'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile: nodeExecFile } = require('child_process');

const MINUTE = 60000;
const TAIL_BYTES = 64 * 1024;
const LIVE_MS = 3 * MINUTE;
const ACTIVITY_GRACE_MS = 2 * MINUTE;
const LABELS = { claude: new Set(['5h', 'week']), codex: new Set(['5h', 'week']), copilot: new Set(['credits']) };
const isLoopbackAddress = address => /^(::1|::ffff:127\.\d+\.\d+\.\d+|127\.\d+\.\d+\.\d+)$/.test(String(address || ''));

function sinceReset(series) {
  const pts = (series || []).filter(p => Number.isFinite(p?.t) && Number.isFinite(p?.used)).sort((a, b) => a.t - b.t);
  let start = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].used < pts[i - 1].used - 1) start = i;
  return { pts: pts.slice(start), reset: start > 0 };
}

function forecastFull(series, now = Date.now(), resetsAt = null, horizonMs = 7 * 864e5) {
  const { pts } = sinceReset(series);
  if (pts.length < 2 || pts.at(-1).t - pts[0].t < 3600e3 || pts.at(-1).used >= 100) return null;
  const mt = pts.reduce((n, p) => n + p.t, 0) / pts.length;
  const mu = pts.reduce((n, p) => n + p.used, 0) / pts.length;
  let num = 0, den = 0;
  for (const p of pts) { num += (p.t - mt) * (p.used - mu); den += (p.t - mt) ** 2; }
  const slope = den ? num / den : 0;
  if (!(slope > 0)) return null;
  const fullAt = Math.round(pts.at(-1).t + (100 - pts.at(-1).used) / slope);
  return fullAt > now && (resetsAt ? fullAt < resetsAt : fullAt - now <= horizonMs) ? fullAt : null;
}

function claudeForecast(samples, key, windowMs, now = Date.now()) {
  const { pts, reset } = sinceReset((samples || []).map(s => ({ t: s?.t, used: s?.u?.[key] })));
  const resetsAt = reset && pts.length ? pts[0].t + windowMs : null;
  return forecastFull(pts, now, resetsAt > now ? resetsAt : null, windowMs);
}

function claudeResetEstimates(samples, now = Date.now()) {
  const valid = (samples || []).filter(s => Number.isFinite(s?.t) && s.u).sort((a, b) => a.t - b.t);
  const out = {};
  for (const [key, label, span] of [['fh', '5h', 5 * 36e5], ['sd', 'week', 7 * 864e5]]) {
    let reset = null;
    for (let i = 1; i < valid.length; i++) if (Number.isFinite(valid[i].u[key]) && Number.isFinite(valid[i - 1].u[key]) && valid[i].u[key] < valid[i - 1].u[key] - 1) reset = valid[i].t;
    if (!reset) continue;
    let resetsAt = reset + span;
    if (resetsAt <= now) resetsAt += (Math.floor((now - resetsAt) / span) + 1) * span;
    out[label] = { resetsAt, estimated: true };
  }
  return out;
}

function claudeMeter(history, now = Date.now()) {
  const samples = Array.isArray(history?.samples) ? history.samples : [];
  const last = samples.filter(s => Number.isFinite(s?.t) && s.u).sort((a, b) => a.t - b.t).at(-1);
  if (!last) return null;
  const windows = [];
  for (const [label, key, span] of [['5h', 'fh', 5 * 36e5], ['week', 'sd', 7 * 864e5]]) {
    if (!Number.isFinite(last.u[key])) continue;
    const fullAt = claudeForecast(samples, key, span, now);
    windows.push({ label, used: last.u[key], ...(fullAt ? { fullAt } : {}) });
  }
  return windows.length ? { id: 'claude', name: 'Claude', family: 'opus', windows, t: last.t } : null;
}

function reportedMeter(reading) {
  if (!reading) return null;
  const names = { claude: ['Claude', 'opus'], codex: ['Codex', 'gpt'], copilot: ['Copilot', 'copilot'] };
  const meta = names[reading.agent];
  return meta ? { id: reading.agent, name: meta[0], family: meta[1], windows: reading.windows.map(w => ({ ...w })), t: reading.t, reported: true, sourceName: reading.source } : null;
}

function newest(...meters) {
  return meters.filter(Boolean).sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0))[0] || null;
}

function codexMeterFromRateLimits(rateLimits, t, extra = {}) {
  if (!rateLimits?.primary) return null;
  const label = min => !min ? '' : min <= 360 ? Math.round(min / 60) + 'h' : min <= 10080 ? 'week' : 'month';
  const windows = [rateLimits.primary, rateLimits.secondary].filter(w => w && Number.isFinite(w.used_percent))
    .map(w => ({ label: label(w.window_minutes), used: w.used_percent, resetsAt: w.resets_at ? w.resets_at * 1000 : null }));
  return windows.length ? { id: 'codex', name: 'Codex', family: 'gpt', plan: rateLimits.plan_type || null, windows, t, ...extra } : null;
}

function codexMeterFromText(text, fallbackTime = Date.now()) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let row; try { row = JSON.parse(lines[i]); } catch { continue; }
    const rl = row.payload?.rate_limits || row.payload?.info?.rate_limits;
    const meter = codexMeterFromRateLimits(rl, Date.parse(row.timestamp) || fallbackTime, { fromLogs: true });
    if (meter) return meter;
  }
  return null;
}

function copilotQuotaMeter(json, t = Date.now()) {
  const snaps = json?.quota_snapshots;
  if (!snaps || typeof snaps !== 'object') return null;
  const resetsAt = Date.parse(json.quota_reset_date) || null;
  const windows = [];
  for (const [key, label] of [['chat', 'credits'], ['completions', 'inline'], ['premium_interactions', 'premium']]) {
    const q = snaps[key];
    if (!q?.has_quota || q.unlimited || !Number.isFinite(q.percent_remaining)) continue;
    windows.push({ label, used: Math.max(0, 100 - q.percent_remaining), resetsAt });
  }
  return windows.length ? { id: 'copilot', name: 'Copilot', family: 'copilot', plan: json.copilot_plan || null, windows, t } : null;
}

function validateUsageReading(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('body must be an object');
  const keys = Object.keys(input);
  if (keys.some(k => !['agent', 'windows', 'source'].includes(k))) throw new Error('unexpected field');
  if (!Object.hasOwn(LABELS, input.agent)) throw new Error('agent must be claude, codex or copilot');
  if (typeof input.source !== 'string' || !input.source.trim() || input.source.length > 100) throw new Error('source must be a non-empty string up to 100 characters');
  if (!Array.isArray(input.windows) || !input.windows.length || input.windows.length > 3) throw new Error('windows must be a non-empty array');
  const seen = new Set();
  const windows = input.windows.map(w => {
    if (!w || typeof w !== 'object' || Array.isArray(w) || Object.keys(w).some(k => !['label', 'used', 'resetsAt'].includes(k))) throw new Error('bad window');
    if (!LABELS[input.agent].has(w.label) || seen.has(w.label)) throw new Error('bad or duplicate window label');
    seen.add(w.label);
    if (!Number.isFinite(w.used) || w.used < 0 || w.used > 100) throw new Error('used must be from 0 to 100');
    let resetsAt = null;
    if (w.resetsAt !== undefined && w.resetsAt !== null && w.resetsAt !== '') {
      resetsAt = typeof w.resetsAt === 'number' ? w.resetsAt : Date.parse(w.resetsAt);
      if (!Number.isFinite(resetsAt)) throw new Error('resetsAt must be an ISO time or epoch milliseconds');
    }
    return { label: w.label, used: w.used, resetsAt };
  });
  return { agent: input.agent, windows, source: input.source.trim(), t: now };
}

function thresholdEvents(meters, now = Date.now()) {
  const out = [];
  for (const meter of meters || []) for (const window of meter.windows || []) {
    if (!Number.isFinite(window.used) || !Number.isFinite(window.resetsAt) || window.used < 80) continue;
    const reset = new Date(window.resetsAt).toISOString(), low = window.used >= 90;
    const type = low ? 'usage.low' : 'usage.high';
    out.push({ event: { type, source: 'usage-meter', severity: low ? 'error' : 'warn', key: `${type}:${meter.id}:${window.label}:${reset}`,
      summary: `${meter.name || meter.id} ${window.label} window reached ${Math.round(window.used)}%`, ref: '/api/stats',
      data: { agent: meter.id, window: window.label, used: window.used, resetsAt: reset } },
      options: { dedupeWindowMs: Math.max(30 * 60000, window.resetsAt - now + 60000),
        ...(low ? { supersedesKeys: [`usage.high:${meter.id}:${window.label}:${reset}`] } : {}) } });
  }
  return out;
}

function runBudgetVerdict(agent, stats, profiles = {}, now = Date.now()) {
  const id = String(agent || 'claude').toLowerCase();
  if (['opencode', 'deepseek', 'kilo'].includes(id)) return { allowed: true, agent: id };
  const meters = new Map((stats?.meters || []).map(meter => [String(meter.id).toLowerCase(), meter]));
  const label = id === 'copilot' ? 'credits' : '5h', verdict = require('./usage-verdict.cjs').meterVerdict(meters.get(id), label, { threshold: 90, now });
  if (verdict.verdict !== 'low') return { allowed: true, agent: id };
  const configured = Array.isArray(profiles?.agents) ? profiles.agents : [];
  const profile = configured.find(item => item.id === id), ordered = [...(profile?.fallbacks || []), ...configured.map(item => item.id)];
  const suggest = ordered.find((candidate, index) => ordered.indexOf(candidate) === index && candidate !== id && (() => {
    if (['opencode', 'deepseek', 'kilo', 'kilocode'].includes(candidate)) return true;
    const candidateLabel = candidate === 'copilot' ? 'credits' : '5h';
    return require('./usage-verdict.cjs').meterVerdict(meters.get(candidate), candidateLabel, { threshold: 90, now }).verdict !== 'low';
  })()) || null;
  return { allowed: false, error: 'usage low', agent: id, used: verdict.used,
    resets: verdict.resetsAt ? new Date(verdict.resetsAt).toISOString() : null, suggest };
}

function readJson(file, io = fs) { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; } }

function defaultClaudeHistory(io = fs, home = os.homedir()) {
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  let packages = []; try { packages = io.readdirSync(path.join(local, 'Packages')).filter(name => /^Claude_/i.test(name)); } catch {}
  for (const name of packages) {
    const file = path.join(local, 'Packages', name, 'LocalCache', 'Roaming', 'Claude', 'plan-usage-history.json');
    try { if (io.existsSync(file)) return file; } catch {}
  }
  return path.join(roaming, 'Claude', 'plan-usage-history.json');
}

function storeUsageReading(file, input, { io = fs, now = Date.now() } = {}) {
  const reading = validateUsageReading(input, now);
  const current = readJson(file, io) || {};
  if (!current[reading.agent] || Number(current[reading.agent].t) <= reading.t) current[reading.agent] = reading;
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  io.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n');
  io.renameSync(tmp, file);
  return reading;
}

function tail(file, io = fs, max = TAIL_BYTES) {
  const fd = io.openSync(file, 'r');
  try {
    const size = io.fstatSync(fd).size, n = Math.min(size, max), buf = Buffer.alloc(n);
    io.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } finally { io.closeSync(fd); }
}

function listSessionFiles({ io = fs, claudeRoot, codexRoot }) {
  const files = [];
  const add = (p, agent) => { try { files.push({ path: p, agent, mtime: io.statSync(p).mtimeMs }); } catch {} };
  let projects = []; try { projects = io.readdirSync(claudeRoot, { withFileTypes: true }); } catch {}
  for (const project of projects) if (project.isDirectory()) {
    let rows = []; try { rows = io.readdirSync(path.join(claudeRoot, project.name), { withFileTypes: true }); } catch {}
    for (const row of rows) if (row.isFile() && row.name.endsWith('.jsonl')) add(path.join(claudeRoot, project.name, row.name), 'claude');
  }
  const walk = (dir, depth = 0) => {
    let rows = []; try { rows = io.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const row of rows) {
      const p = path.join(dir, row.name);
      if (row.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (row.isFile() && /^rollout-.*\.jsonl$/.test(row.name)) add(p, 'codex');
    }
  };
  walk(codexRoot);
  return files.sort((a, b) => b.mtime - a.mtime);
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(v => typeof v === 'string' ? v : v?.text || '').filter(Boolean).join(' ');
  return value?.text || '';
}

function sessionFromFile(file, io = fs) {
  let text; try { text = tail(file.path, io); } catch { return null; }
  let title = '', firstUser = '', summary = '', model = '', cwd = '', startedAt = file.mtime;
  for (const line of text.split(/\r?\n/)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const p = row.payload || row;
    const time = Date.parse(row.timestamp || p.timestamp);
    if (Number.isFinite(time)) startedAt = Math.min(startedAt, time);
    cwd ||= p.cwd || row.cwd || '';
    model ||= p.model || p.message?.model || row.model || '';
    if (!title && (row.type === 'custom-title' || p.type === 'custom-title' || p.type === 'ai-title')) title = textValue(p.customTitle || p.title || p.text || row.title).trim();
    summary ||= textValue(p.summary || row.summary).trim();
    const role = p.role || p.message?.role || p.item?.role;
    if (!firstUser && (role === 'user' || p.type === 'user_message' || p.type === 'UserMessage')) firstUser = textValue(p.message?.content || p.message || p.content || p.item?.content).trim();
    if (file.agent === 'codex' && p.type === 'item_completed' && p.item?.type === 'UserMessage' && !firstUser) firstUser = textValue(p.item.content).trim();
  }
  const project = cwd ? path.basename(cwd) : path.basename(path.dirname(file.path));
  return { title: String(title || summary || firstUser || project || 'untitled').replace(/\s+/g, ' ').slice(0, 70), model, agent: file.agent,
    status: 'working', where: cwd, automated: false, entrypoint: file.agent, project, startedAt, lastActive: file.mtime };
}

function execFilePromise(execFile, command, args, options) {
  return new Promise((resolve, reject) => execFile(command, args, options, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function createUsageMeters(options = {}) {
  const io = options.fs || fs;
  const now = options.now || Date.now;
  const home = options.home || os.homedir();
  const claudeRoot = options.claudeRoot || path.join(home, '.claude', 'projects');
  const codexRoot = options.codexRoot || path.join(home, '.codex', 'sessions');
  const readingsFile = options.readingsFile || path.join(options.runDir || process.cwd(), 'usage-readings.json');
  const claudeHistory = options.claudeHistory || defaultClaudeHistory(io, home);
  const execFile = options.execFile || nodeExecFile;
  const fetchFn = options.fetch || globalThis.fetch;
  const plans = options.plans || {};
  const cache = new Map();
  let lastResult = null;

  const cached = async (key, ttl, producer, fresh = false) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < (fresh ? Math.min(ttl, 10000) : ttl)) return hit.value;
    const value = await producer(); cache.set(key, { at: now(), value }); return value;
  };
  const readHerder = async fresh => cached('herder', 60000, async () => {
    try {
      const response = await fetchFn('http://127.0.0.1:18787/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'model_quotas', arguments: {} } }), signal: AbortSignal.timeout(2500) });
      if (!response.ok) return null;
      const line = (await response.text()).split(/\r?\n/).find(x => x.startsWith('data: '));
      if (!line) return null;
      const rpc = JSON.parse(line.slice(6));
      const provider = rpc.result?.structuredContent?.providers?.find(p => p.provider === 'codex' && p.state === 'reported');
      const d = provider?.details;
      if (!d || !Number.isFinite(d.primary_used)) return null;
      const windows = [{ label: '5h', used: d.primary_used, resetsAt: d.primary_reset_at ? d.primary_reset_at * 1000 : null },
        { label: 'week', used: d.secondary_used, resetsAt: d.secondary_reset_at ? d.secondary_reset_at * 1000 : null }].filter(w => Number.isFinite(w.used));
      return { id: 'codex', name: 'Codex', family: 'gpt', plan: d.plan || null, model: d.model || null, windows,
        t: Date.parse(provider.checkedAt || rpc.result.structuredContent.checkedAt) || now(), fromHerder: true };
    } catch { return null; }
  }, fresh);
  const readCopilot = async fresh => cached('copilot', 10 * MINUTE, async () => {
    try { return copilotQuotaMeter(JSON.parse(await execFilePromise(execFile, 'gh', ['api', '/copilot_internal/user'], { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 })), now()); }
    catch { return null; }
  }, fresh);

  async function read({ fresh = false } = {}) {
    const at = now(), files = listSessionFiles({ io, claudeRoot, codexRoot });
    const history = readJson(claudeHistory, io) || {};
    const reported = readJson(readingsFile, io) || {};
    let claude = newest(claudeMeter(history, at), reportedMeter(reported.claude));
    if (claude) {
      const resets = claudeResetEstimates(history.samples, at);
      claude.windows = claude.windows.map(w => {
        const forecast = w.label === '5h' ? claudeForecast(history.samples, 'fh', 5 * 36e5, at)
          : w.label === 'week' ? claudeForecast(history.samples, 'sd', 7 * 864e5, at) : null;
        return { ...w, ...(!Number.isFinite(w.resetsAt) && resets[w.label] ? resets[w.label] : {}), ...(!Number.isFinite(w.fullAt) && forecast ? { fullAt: forecast } : {}) };
      });
      claude.idleSince = !files.some(f => f.agent === 'claude' && f.mtime > claude.t + ACTIVITY_GRACE_MS);
    }
    let logMeter = null;
    for (const file of files.filter(f => f.agent === 'codex').slice(0, 20)) {
      try { logMeter = newest(logMeter, codexMeterFromText(tail(file.path, io), file.mtime)); } catch {}
    }
    let codex = newest(await readHerder(fresh), logMeter, reportedMeter(reported.codex));
    if (codex) codex.idleSince = !files.some(f => f.agent === 'codex' && f.mtime > codex.t + ACTIVITY_GRACE_MS);
    const copilot = newest(await readCopilot(fresh), reportedMeter(reported.copilot));
    const meters = [claude, codex, copilot].filter(Boolean).map(m => ({ ...m, ...(plans[m.id] ? { plan: plans[m.id] } : {}),
      stale: Number.isFinite(m.t) && at - m.t > (m.id === 'copilot' ? 60 : 30) * MINUTE && m.idleSince !== true }));
    const live = files.filter(f => at - f.mtime <= LIVE_MS).slice(0, 20).map(f => sessionFromFile(f, io)).filter(Boolean);
    lastResult = { source: 'local', fetched: new Date(at).toISOString(), meters, live };
    return lastResult;
  }
  return { read, invalidate() { cache.clear(); lastResult = null; }, latest() { return lastResult; },
    modelNow(agent) { const all = lastResult ? [...lastResult.meters, ...lastResult.live] : []; return all.find(x => x.id === agent)?.model || all.find(x => x.agent === agent)?.model || ''; } };
}

module.exports = { isLoopbackAddress, sinceReset, forecastFull, claudeForecast, claudeResetEstimates, claudeMeter, reportedMeter, newest, codexMeterFromRateLimits,
  codexMeterFromText, copilotQuotaMeter, validateUsageReading, thresholdEvents, runBudgetVerdict, storeUsageReading, defaultClaudeHistory, listSessionFiles, sessionFromFile, createUsageMeters };
