'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sentinelLogRows, writeSentinelLog } = require('../lib/routine-watchdog.cjs');

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const line = (ts, ok = true, summary = 'up') => ({ ts: new Date(ts).toISOString(), mode: 'pc', ok, results: [{ id: 'qmd', ok, summary }] });

test('an unchanged run only bumps the daily rollup', () => {
  let rows = sentinelLogRows([], line(NOW), NOW);
  rows = sentinelLogRows(rows, line(NOW + 60000), NOW + 60000);
  assert.equal(rows.filter(row => row.kind !== 'rollup').length, 1);
  assert.deepEqual(rows.find(row => row.kind === 'rollup'), { kind: 'rollup', mode: 'pc', day: '2026-10-29', runs: 2, ok: 2, failed: 0 });
});

test('a status change appends a line and counts the failure', () => {
  let rows = sentinelLogRows([], line(NOW), NOW);
  rows = sentinelLogRows(rows, line(NOW + 60000, false, 'down'), NOW + 60000);
  assert.equal(rows.filter(row => row.kind !== 'rollup').length, 2);
  assert.equal(rows.find(row => row.kind === 'rollup').failed, 1);
});

test('lines older than 30 days are pruned on write', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-log-')), 'sentinel.jsonl');
  fs.writeFileSync(file, JSON.stringify(line(NOW - 31 * 86400000)) + '\n');
  const rows = writeSentinelLog(file, line(NOW), { now: NOW });
  assert.equal(rows.filter(row => row.kind !== 'rollup').length, 1);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});
