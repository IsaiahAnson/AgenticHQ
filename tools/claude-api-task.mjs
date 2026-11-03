#!/usr/bin/env node
// One-shot Claude API runner for an opt-in Agentic HQ Skills Deck card.
// The regular API key comes from the server process environment, never a repo file.
// --hq-context gathers read-only HQ facts and runs local checks before the model sees them.
// --dry-run prints those facts and checks without calling the API (free; no key needed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { applyRun, dismissTrashed, footer, loadLedger, localChecks, parseModelAnswer, previewDiff, promptDiff, reportFileAt, summarizeOutcomes } from './hq-review-ledger.mjs';
const { recordLocalUsage } = createRequire(import.meta.url)('../lib/anthropic-local-usage.cjs');
const DRY = process.argv.includes('--dry-run'), WITH_HQ = DRY || process.argv.includes('--hq-context');
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_FILE = path.join(KIT, 'data', 'hq-review-ledger.json');
const TRASH_DIR = path.join(KIT, 'artifacts', '_trash');
const key = process.env.ANTHROPIC_API_KEY;
if (!key && !DRY) { console.error('ANTHROPIC_API_KEY is not set. Create a key in the linked Claude Console organization and restart HQ with it in the environment.'); process.exit(1); }

let prompt = '';
try {
  prompt = process.stdin.isTTY ? '' : (await new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { body += chunk; if (body.length > 12000) { process.stdin.destroy(); reject(new Error('Prompt is too long')); } });
    process.stdin.on('end', () => resolve(body.trim()));
    process.stdin.on('error', reject);
  })).trim();
} catch (error) { console.error(error.message); process.exit(1); }
if (!prompt && !DRY) { console.error('No task prompt received on stdin'); process.exit(1); }

const HOUR = 36e5, DAY = 24 * HOUR, now = Date.now();
const r1 = n => Math.round(n * 10) / 10;
const mins = t => (t ? Math.round((t - now) / 6e4) : null);
const ago = t => (t ? r1((now - t) / HOUR) : null);

// Local machine facts: memory, free disk per fixed drive, and leaked headless test browsers.
function machine() {
  const m = { ramUsedPct: r1(100 - (os.freemem() / os.totalmem()) * 100), ramTotalGB: r1(os.totalmem() / 2 ** 30), disks: [] };
  for (const d of process.platform === 'win32' ? 'CDEFG'.split('').map(l => l + ':\\') : ['/']) {
    try { const s = fs.statfsSync(d); if (s.blocks) m.disks.push({ drive: d, freeGB: r1((s.bavail * s.bsize) / 2 ** 30), freePct: r1((s.bavail / s.blocks) * 100) }); } catch { /* drive absent */ }
  }
  if (process.platform === 'win32') {
    const ps = "@(Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*hqcdp-*' }).Count";
    const out = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const n = parseInt(out.stdout, 10); if (Number.isFinite(n)) m.leakedTestBrowsers = n;
  }
  return m;
}

async function hqContext() {
  const base = `http://127.0.0.1:${Number(process.env.HQ_PORT || process.env.PORT) || 50000}`;
  const headers = process.env.RUBRIC_TOKEN ? { 'x-rubric-token': process.env.RUBRIC_TOKEN } : {};
  const names = ['health', 'stats', 'outcomes', 'routines', 'artifacts', 'apps', 'skills'];
  const got = await Promise.allSettled(names.map(async n => {
    const res = await fetch(`${base}/api/${n}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }));
  const src = {}, gaps = [];
  names.forEach((n, i) => (got[i].status === 'fulfilled' ? (src[n] = got[i].value) : gaps.push(`/api/${n} unavailable (${got[i].reason.message})`)));
  if (!src.health && !src.stats) throw new Error('HQ health and stats are both unavailable - is HQ running on port 50000?');
  const h = src.health || {};

  const meters = (src.stats?.meters || []).filter(m => m.id !== 'claude-api').map(m => ({
    id: m.id, plan: m.plan, stale: !!m.stale, readingAgeMin: m.t ? Math.round((now - m.t) / 6e4) : null,
    windows: (m.windows || []).map(w => ({ label: w.label, used: r1(w.used), estimated: !!w.estimated,
      resetsInMin: mins(w.resetsAt), runsOutInMin: w.fullAt && w.fullAt < (w.resetsAt || Infinity) ? mins(w.fullAt) : null }))
  }));
  const apiMeter = (src.stats?.meters || []).find(m => m.id === 'claude-api');

  // Runs: deck card ids, Orca task ids, status and timing only. Orca's taskType is the worker's prompt text, so it never leaves this machine.
  const outcomes = (src.outcomes?.outcomes || []).map(o => ({ ...o, end: Date.parse(o.endedAt || o.startedAt) })).filter(o => o.end && now - o.end < DAY);
  const runSummary = summarizeOutcomes(outcomes, now);

  const switches = src.routines?.switches || [];
  const arts = src.artifacts?.artifacts || [];
  const newestArt = Math.max(0, ...arts.map(a => Date.parse(a.modified || a.created) || 0));
  const ctx = {
    time: h.time || new Date(now).toISOString(),
    hq: { ok: h.ok, engine: h.engine, workspaceSet: h.workspaceSet, runner: h.runner, deckRunner: src.skills?.runner },
    companionsDown: Object.entries(h.companions || {}).filter(([, up]) => !up).map(([k]) => k),
    companionsUp: Object.values(h.companions || {}).filter(Boolean).length,
    appsDown: (src.apps?.apps || []).filter(a => !a.builtIn && a.live === false).map(a => a.name || a.id),
    meters,
    apiCredit: apiMeter ? { note: apiMeter.note || null, stale: !!apiMeter.stale } : null,
    runs24h: { ...runSummary, sources: src.outcomes?.sources },
    routines: { needsSetup: !!src.routines?.needsSetup, on: switches.filter(s => s.on).map(s => `${s.name} (${s.when})`), offCount: switches.filter(s => !s.on).length, counts: src.routines?.counts,
      missed: (src.routines?.missed || []).map(r => ({ id: r.id, name: r.name, source: r.source, missed: r.missed, lastRunAt: r.lastRunAt })) },
    artifacts: { count: arts.length, newestHoursAgo: newestArt ? ago(newestArt) : null },
    deckCards: (src.skills?.skills || []).length,
    machine: machine(),
    gaps
  };
  ctx.checks = localChecks(ctx);
  return ctx;
}

const SYSTEM = `You review the health of Agentic HQ, a local AI-agent homepage, using only the JSON facts provided.
"checks" were computed by code and are reliable. "ledgerDiff" says what is new, fixed, still open, dismissed, or newly escalated.
Reply in markdown:
**Verdict:** Healthy | Watch | Action needed - one short reason.
### New
Full detail for each new or escalated finding: **title** - evidence quoting the exact numbers - Fix: one concrete step. Write "None" if empty.
### Fixed since last run
One line per fixed finding. Write "None" if empty.
### Still open
One line per open finding, ending with "seen N times since <date>". Write "None" if empty.
End with a one-line count footer. Dismissed findings must be omitted completely from every section.
After the markdown, return a fenced JSON block containing an array of { "id", "title", "level" } for every current finding. Reuse check IDs exactly. A finding not present in checks must use id "model:<short-kebab-slug>".
Rules: never invent status, numbers or causes; write "unknown" when unsure. Don't infer private activity. Never recommend purchases or plan changes. Do not include secrets.
Known fixes: missing API key -> restart HQ with tools/start-hq-with-claude-api.ps1; companion down -> run start-all.cmd in the companions folder; stale meter -> open that agent so its usage refreshes; leaked hqcdp browsers -> stop msedge processes whose command line has an hqcdp- profile; failing card -> open its newest log in os-runs/.`;

function fallback(ctx, why) {
  const lines = [`**Verdict:** ${ctx.checks.some(c => c.level === 'act') ? 'Action needed' : ctx.checks.length ? 'Watch' : 'Healthy'} (local checks only: ${why})`, ''];
  for (const c of ctx.checks) lines.push(`- **${c.level === 'act' ? 'Act' : 'Watch'}:** ${c.title} - ${c.evidence}`);
  if (!ctx.checks.length) lines.push('- All local checks passed.');
  return lines.join('\n');
}

let ctx = null, ledger = dismissTrashed(loadLedger(LEDGER_FILE), TRASH_DIR);
try {
  if (WITH_HQ) {
    ctx = await hqContext();
    ctx.ledgerDiff = promptDiff(previewDiff(ledger, ctx.checks));
  }
  if (DRY) {
    const at = new Date(now).toISOString(), report = reportFileAt(new Date(now));
    const wouldWrite = applyRun(ledger, ctx.checks, { at, report });
    console.log(JSON.stringify({ facts: ctx, ledgerDiff: ctx.ledgerDiff, wouldWrite }, null, 2));
    console.log('\n' + fallback(ctx, 'dry run, no API call; ledger not saved'));
    process.exit(0);
  }
  const context = ctx ? `\n\nCurrent HQ facts (read-only; no prompts, session titles or personal content):\n${JSON.stringify(ctx)}` : '';
  const call = () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    // Sonnet 5.5 thinks by default at high effort and rejects disabling it; at 1200 max_tokens the
    // thinking used the whole budget and no text came back. Low effort plus headroom keeps it short.
    body: JSON.stringify({ model: process.env.ANTHROPIC_API_MODEL || 'claude-opus-5-5', max_tokens: 8000,
      output_config: { effort: process.env.ANTHROPIC_API_EFFORT || 'low' },
      system: ctx ? SYSTEM : 'Answer from the provided facts. Keep it concise, state uncertainty, and never invent missing status or usage.',
      messages: [{ role: 'user', content: prompt + context }] }),
    signal: AbortSignal.timeout(90000)
  });
  let response = await call();
  if (response.status === 429 || response.status >= 500) {   // one retry for rate limits and overload
    const wait = Math.min(20, Number(response.headers.get('retry-after')) || 5);
    await new Promise(r => setTimeout(r, wait * 1000));
    response = await call();
  }
  if (!response.ok) {
    const detail = await response.json().then(j => j?.error?.message, () => null);
    throw new Error(`Claude API HTTP ${response.status}${detail ? ` - ${detail}` : ''}`);
  }
  const result = await response.json();
  recordLocalUsage({ source: 'api-hq-review', model: result.model, usage: result.usage });
  const answer = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  if (!answer) throw new Error(`Claude API returned no text (stop_reason ${result.stop_reason}${result.stop_details?.category ? `, ${result.stop_details.category}` : ''}, ${result.usage?.output_tokens ?? '?'} output tokens)`);
  const parsed = ctx ? parseModelAnswer(answer, ctx.checks) : { markdown: answer, findings: [], valid: true };
  let printed = parsed.markdown
    .replace(/\n?_?[0-9]+ new\s*[·â€¢]\s*[0-9]+ fixed\s*[·â€¢]\s*[0-9]+ (?:still )?open\s*[·â€¢]\s*[0-9]+ dismissed[^\n]*_?\s*$/i, '')
    .replace(/\n?[0-9]+ new[^\n]*(?:open|dismissed)[^\n]*\.?\s*$/i, '').trim();
  if (ctx) {
    const at = new Date().toISOString(), report = reportFileAt(new Date(at));
    ledger = applyRun(ledger, parsed.findings, { at, report });
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n');
    printed += `\n\n${footer(ledger, parsed.valid)}`;
  }
  console.log(printed);
  if (result.stop_reason === 'max_tokens') console.log('\n_(Review was cut off at the token limit.)_');
  if (ctx) console.log(`\n_${ctx.checks.length} local checks · ${7 - ctx.gaps.length}/7 HQ sources · ${result.model}_`);
} catch (error) {
  console.error(`Claude API task failed: ${error.message}`);
  if (ctx) {
    const at = new Date().toISOString(), report = reportFileAt(new Date(at));
    ledger = applyRun(ledger, ctx.checks, { at, report });
    fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
    fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2) + '\n');
    console.log(fallback(ctx, 'the API call failed') + '\n\n' + footer(ledger, false));
  }
  process.exitCode = 1;
}
