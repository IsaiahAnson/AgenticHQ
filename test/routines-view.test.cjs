'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const view = require('../lib/routines-view.cjs');

test('all sentinel observations enrich routines while only failures enter missed', () => {
  const sentinel = {
    'routine-missed:daily': { ok: true, data: { id: 'daily', source: 'desktop', missed: 0, lastRunAt: '2026-10-29T12:00:00Z' } },
    'routine-missed:late': { ok: false, data: { id: 'late', source: 'desktop', missed: 2, lastRunAt: '2026-10-28T12:00:00Z' } }
  };
  const all = { routines: [
    { id: 'rt:task-daily', name: 'Daily', origin: 'desktop scheduler', status: 'active', scheduleText: 'daily', path: 'C:\\tasks\\daily\\SKILL.md' },
    { id: 'rt:task-late', name: 'Late', origin: 'desktop scheduler', status: 'paused', scheduleText: 'daily', path: 'C:\\tasks\\late\\SKILL.md' }
  ] };
  const out = view.build({ all, rows: { routines: [{ id: 'rt:task-daily' }] }, sentinel, models: {}, now: Date.parse('2026-10-29') });
  assert.equal(out.switches[0].lastRunAt, '2026-10-29T12:00:00Z');
  assert.equal(out.switches[0].status, 'ok');
  assert.deepEqual(out.missed.map(row => row.id), ['late']);
});

test('pulse supplies missing last run, result and status without overwriting sentinel data', () => {
  const payload = { switches: [
    { task: 'one', lastRunAt: null, lastResult: null, status: null, pulse: { lastRun: { at: '2026-10-29T13:00:00Z', ok: false }, strip: [{ status: 'fail' }] } },
    { task: 'two', lastRunAt: 'kept', lastResult: 0, status: 'ok', pulse: { lastRun: { at: 'other', ok: false } } }
  ] };
  const out = view.fillFromPulse(payload);
  assert.deepEqual([out.switches[0].lastRunAt, out.switches[0].lastResult, out.switches[0].status], ['2026-10-29T13:00:00Z', false, 'fail']);
  assert.deepEqual([out.switches[1].lastRunAt, out.switches[1].lastResult, out.switches[1].status], ['kept', 0, 'ok']);
});
