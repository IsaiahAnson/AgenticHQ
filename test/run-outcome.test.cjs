'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { appendOutcome, parseRunOutcome, pushOutcome, readOutcomeLog } = require('../lib/run-outcome.cjs');
const { hqOutcomes } = require('../lib/hq-outcomes.cjs');

test('exit-1 run is failed and keeps the last error line', () => {
  assert.deepEqual(parseRunOutcome({ exitCode: 1, output: 'working\nError: dry failure' }), { status: 'failed', next: 'Error: dry failure' });
});

test('Next action: none is done', () => {
  assert.deepEqual(parseRunOutcome({ exitCode: 0, output: 'Next action: none' }), { status: 'done', next: 'Next action: none' });
});

test('a real last next action needs action', () => {
  assert.deepEqual(parseRunOutcome({ exitCode: 0, output: 'Next action: old\nBest maintenance action: Clear the stale queue.' }), {
    status: 'needs-action', next: 'Best maintenance action: Clear the stale queue.'
  });
});

test('explicit Status line wins on a successful run', () => {
  assert.deepEqual(parseRunOutcome({ exitCode: 0, output: 'Next action: inspect later\nStatus: done' }), { status: 'done', next: 'Next action: inspect later' });
});

test('missing action line is done', () => {
  assert.deepEqual(parseRunOutcome({ exitCode: 0, output: 'All checks passed.' }), { status: 'done', next: null });
});

test('BOM-prefixed JSONL skips one bad line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-outcomes-'));
  const file = path.join(dir, 'routine-outcomes.jsonl');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ ts: '2026-10-28T10:00:00Z', routine: 'morning-action-brief', status: 'needs-action', next: 'Next action: Review.', source: 'desktop', report: null, key: 'ignored' }) + '\nnot json\n');
  const result = readOutcomeLog(file);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].routine, 'morning-action-brief');
  assert.equal(result.records[0].source, 'desktop');
  assert.equal(result.skipped, 1);
});

test('desktop healthy and changed statuses read as done, keeping what was reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-outcomes-'));
  const file = path.join(dir, 'routine-outcomes.jsonl');
  fs.writeFileSync(file, ['healthy', 'changed'].map(status => JSON.stringify({ ts: '2026-10-28T22:04:00Z', routine: 'release-radar', status, next: 'Review the list' })).join('\n') + '\n');
  const result = readOutcomeLog(file);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.records.map(r => [r.status, r.reported, r.source]), [['done', 'healthy', 'desktop'], ['done', 'changed', 'desktop']]);
});

test('HQ outcomes expose the desktop morning brief as needs-action', () => {
  const kitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-outcomes-api-'));
  fs.mkdirSync(path.join(kitDir, 'data'));
  fs.mkdirSync(path.join(kitDir, 'os-runs'));
  fs.writeFileSync(path.join(kitDir, 'data', 'runs.json'), '[]');
  fs.writeFileSync(path.join(kitDir, 'os-runs', 'routine-outcomes.jsonl'), JSON.stringify({
    ts: '2026-10-28T11:14:43-04:00', routine: 'morning-action-brief', status: 'needs-action',
    next: 'Next action: Confirm the review time.', source: 'desktop', report: null
  }) + '\n');
  const rows = hqOutcomes({ kitDir });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'desktop');
  assert.equal(rows[0].taskType, 'morning-action-brief');
  assert.equal(rows[0].status, 'needs-action');
});

test('notification policy pushes once and dedupes for 24 hours', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-outcome-push-'));
  const file = path.join(dir, 'routine-outcomes.jsonl');
  const record = appendOutcome(file, { ts: '2026-10-28T10:00:00Z', routine: 'dry-card', status: 'failed', next: 'Error: dry failure', source: 'deck', report: 'dry-card.html' });
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200 }; };
  const attentionOptions = { config: { dailyPushes: 3 }, onEvent: () => {} };
  const first = await pushOutcome(record, { statuses: ['failed'], dir, now: Date.parse('2026-10-28T12:00:00Z'), fetchImpl, attentionOptions });
  const second = await pushOutcome(record, { statuses: ['failed'], dir, now: Date.parse('2026-10-28T13:00:00Z'), fetchImpl, attentionOptions });
  assert.equal(first.pushed, true);
  assert.equal(second.reason, 'duplicate');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.title, 'dry-card failed');
  assert.equal(body.priority, 5);
  assert.match(body.click, /\/artifacts\/dry-card\.html$/);
  assert.equal(body.actions[0].label, 'Dismiss');
});
