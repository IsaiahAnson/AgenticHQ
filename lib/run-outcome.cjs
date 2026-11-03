'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VALID_STATUSES = new Set(['done', 'needs-action', 'failed']);
// Desktop routine prompts report healthy|changed|needs-action|failed; both of the first two mean "ran, nothing for you".
const STATUS_ALIASES = { healthy: 'done', changed: 'done', ok: 'done' };
const NO_ACTION = /^(?:none|nothing|no\s+(?:action|actions|maintenance|follow[- ]?up)(?:\s+(?:needed|required|to\s+do))?|n\/?a|not\s+(?:needed|required))\.?$/i;
const ACTION_LINE = /^\s*(Next action|Best maintenance action)\s*:\s*(.*?)\s*$/i;
const STATUS_LINE = /^\s*Status\s*:\s*(done|needs-action|failed)\s*$/i;
const ERROR_LINE = /\b(error|failed|failure|fatal|exception)\b/i;
const SENSITIVE_LINE = /(?:\b(?:api[_ -]?key|password|secret|authorization|bearer|account\s*(?:number|#)|phone|e-?mail)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;

function oneLine(value, limit = 500) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function outcomeKey({ routine, status, next }) {
  return crypto.createHash('sha256').update([routine, status, next || ''].join('\n')).digest('hex').slice(0, 24);
}

function parseRunOutcome({ exitCode = 0, output = '' } = {}) {
  const lines = String(output || '').split(/\r?\n/);
  let explicit = null;
  let action = null;
  let lastError = null;
  for (const line of lines) {
    const statusMatch = line.match(STATUS_LINE);
    if (statusMatch) explicit = statusMatch[1].toLowerCase();
    const actionMatch = line.match(ACTION_LINE);
    if (actionMatch) action = { label: actionMatch[1], value: oneLine(actionMatch[2]) };
    if (ERROR_LINE.test(line) && oneLine(line)) lastError = oneLine(line);
  }

  if (Number(exitCode) !== 0) {
    return { status: 'failed', next: action ? `${action.label}: ${action.value}` : (lastError || `Run exited with code ${exitCode}`) };
  }
  if (explicit) return { status: explicit, next: action ? `${action.label}: ${action.value}` : null };
  if (!action || NO_ACTION.test(action.value)) return { status: 'done', next: action ? `${action.label}: ${action.value}` : null };
  return { status: 'needs-action', next: `${action.label}: ${action.value}` };
}

function makeOutcome({ ts = new Date().toISOString(), routine, status, next = null, source, report = null } = {}) {
  const cleanRoutine = oneLine(routine, 160);
  const cleanNext = next ? oneLine(next) : null;
  const reported = String(status || '').toLowerCase();
  const cleanStatus = STATUS_ALIASES[reported] || reported;
  const cleanSource = String(source || '').toLowerCase();
  if (!cleanRoutine) throw new Error('Outcome routine is required');
  if (!VALID_STATUSES.has(cleanStatus)) throw new Error(`Invalid outcome status: ${status}`);
  if (!['deck', 'desktop', 'sentinel'].includes(cleanSource)) throw new Error(`Invalid outcome source: ${source}`);
  const record = { ts: new Date(ts).toISOString(), routine: cleanRoutine, status: cleanStatus, next: cleanNext, source: cleanSource, report: report ? oneLine(report, 260) : null };
  if (reported !== cleanStatus) record.reported = reported;
  record.key = outcomeKey(record);
  return record;
}

function appendOutcome(file, record) {
  const normalized = makeOutcome(record);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(normalized) + '\n', 'utf8');
  return normalized;
}

function readOutcomeLog(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { return error.code === 'ENOENT' ? { records: [], skipped: 0 } : { records: [], skipped: 1 }; }
  const records = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      records.push(makeOutcome({ ...row, source: row.source || 'desktop' }));
    } catch (_) { skipped++; }
  }
  return { records, skipped };
}

function safePushText(record) {
  const candidate = oneLine(record.next || `${record.routine} failed`, 300);
  return SENSITIVE_LINE.test(candidate) ? 'Run failed; open the local report for details.' : candidate;
}

// Goes through the attention budget (lib/attention.cjs), which owns the 24 h per-key dedupe.
// A failed run is urgent (always buzzes); other enabled statuses are normal.
async function pushOutcome(record, { statuses = ['failed'], dir, hqUrl = 'http://localhost:50000', now = Date.now(), fetchImpl = globalThis.fetch, attentionOptions = {} } = {}) {
  if (!statuses.includes(record.status)) return { pushed: false, reason: 'status-disabled' };
  const report = record.report ? String(record.report).replace(/\\/g, '/').replace(/^\/?artifacts\//, '') : null;
  const click = report ? `${hqUrl}/artifacts/${report.split('/').map(encodeURIComponent).join('/')}` : hqUrl;
  const result = await require('./attention.cjs').notify({
    source: `${record.source}:${record.routine}`, title: `${record.routine} ${record.status === 'failed' ? 'failed' : record.status}`,
    text: safePushText(record), priority: record.status === 'failed' ? 'urgent' : 'normal', key: record.key, click
  }, { dir, now, fetchImpl, hqUrl, ...attentionOptions });
  return { pushed: result.sent, reason: result.reason };
}

async function recordDeckOutcome({ kitDir, routine, exitCode, output, report, config = {}, fetchImpl } = {}) {
  const parsed = parseRunOutcome({ exitCode, output });
  const record = appendOutcome(path.join(kitDir, 'os-runs', 'routine-outcomes.jsonl'), {
    ...parsed, routine, source: 'deck', report: report || null
  });
  let notification = { pushed: false, reason: 'status-disabled' };
  try {
    notification = await pushOutcome(record, {
      statuses: Array.isArray(config.outcomePush) ? config.outcomePush : ['failed'],
      dir: path.join(kitDir, 'data'),
      fetchImpl
    });
  } catch (error) {
    notification = { pushed: false, reason: 'push-failed', error: oneLine(error.message, 200) };
  }
  return { record, notification };
}

module.exports = { appendOutcome, makeOutcome, outcomeKey, parseRunOutcome, pushOutcome, readOutcomeLog, recordDeckOutcome, safePushText };
