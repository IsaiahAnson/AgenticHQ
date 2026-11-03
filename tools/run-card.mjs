#!/usr/bin/env node
// Start one HQ deck card from a schedule (Windows Task Scheduler), through the same POST /api/run a click uses.
//   node tools/run-card.mjs <card-id> [--ingest] [--dry-run]
// --ingest runs tools/ingest/run-all.mjs first (session-lessons). The card is skipped, with an event, when HQ is
// down or the card's agent is low on usage (usage-check exit 3). Results land where a click's would: os-runs/,
// the ring, and job.succeeded / job.failed events.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const HQ = 'http://localhost:50000';
const id = process.argv[2];
const DRY = process.argv.includes('--dry-run');
if (!id || id.startsWith('--')) { console.error('usage: node tools/run-card.mjs <card-id> [--ingest] [--dry-run]'); process.exit(2); }

async function post(p, body, ms = 15000) {
  const r = await fetch(HQ + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function event(type, severity, summary) {
  try { await post('/local/event', { type, severity, source: 'run-card', key: `run-card-${id}-${type}-${new Date().toISOString().slice(0, 13)}`, summary }, 4000); } catch { }
}

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'os-config.json'), 'utf8'));
const card = (cfg.skills || []).find(s => s.id === id);
if (!card) { console.error(`no deck card "${id}" in os-config.json`); process.exitCode = 2; }
else {
  const agent = card.agent || 'claude';
  let skip = null;
  try { await fetch(HQ + '/api/health', { signal: AbortSignal.timeout(5000) }); } catch { skip = 'HQ is not running'; }
  if (!skip && ['claude', 'codex', 'copilot'].includes(agent)) {
    try { execFileSync(process.execPath, [path.join(ROOT, 'tools', 'usage-check.mjs'), `--agent=${agent}`], { stdio: 'pipe' }); }
    catch (e) { if (e.status === 3) skip = `${agent} usage is low`; }
  }
  if (skip) {
    console.log(`skipped ${id}: ${skip}`);
    if (!DRY) await event('routine.skipped', 'warn', `${id} skipped: ${skip}`);
  } else {
    if (process.argv.includes('--ingest')) {
      try { execFileSync(process.execPath, [path.join(ROOT, 'tools', 'ingest', 'run-all.mjs')].concat(DRY ? ['--dry-run'] : []), { stdio: 'inherit', timeout: 15 * 60000 }); }
      catch (e) { await event('ingest.failed', 'error', `ingest run-all failed (${e.status ?? e.message})`); }
    }
    // /api/run wants dial names, like a click sends; the card stores indexes into the os-config lists.
    const MODELS = (cfg.models || ['HAIKU', 'SONNET', 'OPUS', 'FABLE']).map(String);
    const EFFORTS = (cfg.efforts || ['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']).map(String);
    const model = MODELS[card.model ?? 2] ?? 'OPUS', effort = EFFORTS[card.effort ?? 1] ?? 'MEDIUM';
    const { status, json } = await post('/api/run', { id, model, effort, dryRun: DRY });
    console.log(status, JSON.stringify(DRY ? { ok: json.ok, dryRun: json.dryRun, promptChars: (json.prompt || '').length, hasPacket: /## HQ context packet/.test(json.prompt || '') } : json));
    if (status >= 400 || json.error) { process.exitCode = 1; if (!DRY) await event('routine.failed', 'error', `${id} did not start: ${json.error || status}`); }
  }
}
