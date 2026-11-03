'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { attachPulse } = require('../lib/routine-pulse.cjs');

const days = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'];
const row = (id, extra = {}) => ({
  id,
  name: id,
  kind: id.split('-')[0],
  dots: ['none', 'ok', 'fail', 'miss', 'unknown', 'ok', 'none'],
  useful: { kept: 2, opened: 1, trashed: 3, total: 5 },
  noisy: false,
  lastRun: { at: '2026-10-27T14:00:00.000Z', ok: true },
  open: '/artifacts/report.html',
  ...extra
});
const pulse = rows => ({ days, keptDays: 14, rows });

test('desktop pulse attaches to every firing and its switch', () => {
  const input = {
    routines: [
      { id: 'rt:task-morning-brief', at: '08:00' },
      { id: 'rt:task-morning-brief', at: '12:00' },
      { id: 'rt:task-other', at: '09:00' }
    ],
    switches: [{ task: 'morning-brief', on: true }, { task: 'other', on: true }]
  };
  const out = attachPulse(input, pulse([row('desktop-morning-brief')]));

  assert.deepEqual(out.routines.slice(0, 2).map(r => r.pulse), [out.routines[0].pulse, out.routines[0].pulse]);
  assert.equal(out.routines[2].pulse, undefined);
  assert.equal(out.switches[0].pulse.total, 5);
  assert.equal(out.switches[1].pulse, undefined);
  assert.deepEqual(out.routines[0].pulse.strip, days.map((day, index) => ({ day, status: row('x').dots[index] })));
});

test('windows pulse strips the agentic-hq prefix when matching routine ids', () => {
  const out = attachPulse({ routines: [{ id: 'rt:hq-session-lessons' }] }, pulse([row('windows-agentic-hq-session-lessons')]));
  assert.equal(out.routines[0].pulse.kept, 2);
  assert.deepEqual(out.pulseOthers, []);
});

test('deck cards and desktop automations not firing today remain in pulseOthers in pulse order', () => {
  const rows = [row('deck-api-review'), row('desktop-not-today', { useful: null, open: null, lastRun: null })];
  const out = attachPulse({ routines: [], switches: [{ task: 'not-today' }] }, pulse(rows));

  assert.deepEqual(out.pulseOthers.map(item => item.id), ['deck-api-review', 'desktop-not-today']);
  assert.equal(out.pulseOthers[1].pulse.total, null);
  assert.equal(out.pulseOthers[1].pulse.kept, null);
  assert.ok(out.switches[0].pulse, 'a switch can match while the pulse row remains in pulseOthers');
  assert.deepEqual(out.pulseDays, days);
  assert.equal(out.keptDays, 14);
});

test('null routines input produces a valid payload with all pulse rows as others', () => {
  const out = attachPulse(null, pulse([row('deck-api-review')]));
  assert.deepEqual(out.routines, []);
  assert.deepEqual(out.switches, []);
  assert.equal(out.pulseOthers[0].id, 'deck-api-review');
});

test('missing and failed pulse preserve the routine payload and describe the error', () => {
  const input = { routines: [{ id: 'rt:task-one' }], switches: [], marker: true };
  assert.deepEqual(attachPulse(input, null), { ...input, pulseOthers: [], pulseError: 'no pulse' });
  assert.deepEqual(attachPulse(input, { error: new Error('pulse broke') }), { ...input, pulseOthers: [], pulseError: 'pulse broke' });
});
