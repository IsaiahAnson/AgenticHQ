'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { forecast, windowReadings } = require('../lib/usage-forecast.cjs');
const HQ = require('../assets/time12.js');

const H = 36e5;
const NOW = Date.parse('2026-10-28T14:00:00Z');   // Wed 10:00 New York
const iso = ms => new Date(ms).toISOString();
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); };
const stamp = t => dayKey(t) === dayKey(NOW) ? HQ.time(t) : WEEKDAY.format(new Date(t)) + ' ' + HQ.time(t);
const row = (hoursAgo, agent, list) => ({ ts: iso(NOW - hoursAgo * H), meters: { [agent]: list } });
const multi = (hoursAgo, meters) => ({ ts: iso(NOW - hoursAgo * H), meters });

test('only readings inside the newest reset window count', () => {
  const reset = NOW + 2 * H, old = NOW - 18 * H;
  const history = [
    row(4, 'codex', [{ label: '5h', used: 50, resetsAt: old }]),
    row(2, 'codex', [{ label: '5h', used: 10, resetsAt: reset }]),
    row(1, 'codex', [{ label: '5h', used: 30, resetsAt: reset }])
  ];
  const m = forecast(history, { now: NOW }).meters[0];
  assert.equal(m.ratePerHour, 20);
  assert.equal(m.projectedAtReset, 70);
  assert.equal(m.verdict, 'ok');
  assert.deepEqual(m.spark, [10, 30]);
  assert.equal(windowReadings([...history].map(r => ({ t: Date.parse(r.ts), meters: r.meters })), 'codex', '5h', reset).length, 2);
});

test('a reset 60 s away is the same window, 120 s away is not', () => {
  const reset = NOW + 2 * H;
  const history = [
    row(2, 'claude', [{ label: 'week', used: 20, resetsAt: reset + 120e3 }]),
    row(1.5, 'claude', [{ label: 'week', used: 20, resetsAt: reset + 45e3 }]),
    row(1, 'claude', [{ label: 'week', used: 40, resetsAt: reset }])
  ];
  const m = forecast(history, { now: NOW }).meters[0];
  assert.deepEqual(m.spark, [20, 40]);
  assert.equal(m.ratePerHour, 40);
});

test('null rate: one reading, a short span, or no slope is "not enough readings yet"', () => {
  const reset = NOW + 3 * H;
  const one = forecast([row(1, 'claude', [{ label: 'week', used: 21, resetsAt: reset }])], { now: NOW }).meters[0];
  assert.equal(one.ratePerHour, null);
  assert.equal(one.projectedAtReset, 21);
  assert.equal(one.hitAt, null);
  assert.equal(one.text, 'Claude week: 21% used, not enough readings yet');

  const short = forecast([
    row(0.5, 'codex', [{ label: '5h', used: 10, resetsAt: reset }]),
    row(0.33, 'codex', [{ label: '5h', used: 20, resetsAt: reset }])
  ], { now: NOW }).meters[0];
  assert.equal(short.ratePerHour, null, '10 minutes of readings is under the 30 minute floor');
});

test('over: runs out before the reset, with both times in 12-hour form', () => {
  const reset = NOW + H;
  const history = [
    row(2, 'codex', [{ label: '5h', used: 40, resetsAt: reset }]),
    row(1, 'codex', [{ label: '5h', used: 80, resetsAt: reset }])
  ];
  const m = forecast(history, { now: NOW }).meters[0];
  assert.equal(m.ratePerHour, 40);
  assert.equal(m.projectedAtReset, 120);
  assert.equal(m.verdict, 'over');
  assert.equal(m.hitAt, NOW + 0.5 * H);
  assert.equal(m.text, 'Codex 5h: 80% used, runs out about ' + stamp(NOW + 0.5 * H) + ' (resets ' + stamp(reset) + ')');
});

test('tight at 85 and ok below it', () => {
  const reset = NOW + 1.75 * H;
  const tight = forecast([
    row(2, 'codex', [{ label: 'week', used: 30, resetsAt: reset }]),
    row(1, 'codex', [{ label: 'week', used: 50, resetsAt: reset }])
  ], { now: NOW }).meters[0];
  assert.equal(tight.projectedAtReset, 85);
  assert.equal(tight.verdict, 'tight');
  assert.equal(tight.hitAt, null);
  assert.match(tight.text, /^Codex week: 50% used, on pace for 85% by .+ reset$/);

  const ok = forecast([
    row(2, 'copilot', [{ label: 'credits', used: 10, resetsAt: NOW + H }]),
    row(1, 'copilot', [{ label: 'credits', used: 20, resetsAt: NOW + H }])
  ], { now: NOW }).meters[0];
  assert.equal(ok.projectedAtReset, 30);
  assert.equal(ok.verdict, 'ok');
});

test('a falling meter has rate 0, not a negative projection', () => {
  const reset = NOW + 2 * H;
  const m = forecast([
    row(2, 'claude', [{ label: 'week', used: 80, resetsAt: reset }]),
    row(1, 'claude', [{ label: 'week', used: 60, resetsAt: reset }])
  ], { now: NOW }).meters[0];
  assert.equal(m.ratePerHour, 0);
  assert.equal(m.projectedAtReset, 60);
  assert.deepEqual(m.spark, [80, 60]);
});

test('sort over > tight > ok, then by projected descending', () => {
  const rc = NOW + 1.5 * H, rp = NOW + 2.5 * H, rx = NOW + H;
  const history = [
    multi(2, { claude: [{ label: 'week', used: 40, resetsAt: rc }], copilot: [{ label: 'credits', used: 50, resetsAt: rp }], codex: [{ label: '5h', used: 10, resetsAt: rx }] }),
    multi(1, { claude: [{ label: 'week', used: 70, resetsAt: rc }], copilot: [{ label: 'credits', used: 60, resetsAt: rp }], codex: [{ label: '5h', used: 15, resetsAt: rx }] })
  ];
  const meters = forecast(history, { now: NOW }).meters;
  assert.deepEqual(meters.map(m => m.agent), ['claude', 'copilot', 'codex']);
  assert.deepEqual(meters.map(m => m.verdict), ['over', 'tight', 'ok']);
});

test('weekday appears only when the reset is not today', () => {
  const later = NOW + 3 * 24 * H;
  const m = forecast([
    row(2, 'codex', [{ label: 'week', used: 10, resetsAt: later }]),
    row(1, 'codex', [{ label: 'week', used: 10.1, resetsAt: later }])
  ], { now: NOW }).meters[0];
  assert.equal(m.verdict, 'ok');
  assert.match(m.text, new RegExp('by ' + WEEKDAY.format(new Date(later)) + ' ' + HQ.time(later).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' reset$'));
});

test('spark keeps the last 24 readings and the projection caps at 999', () => {
  const reset = NOW + H;
  const history = [];
  for (let i = 29; i >= 0; i--) history.push(row(i, 'codex', [{ label: '5h', used: 30 - i, resetsAt: reset }]));
  const m = forecast(history, { now: NOW }).meters[0];
  assert.equal(m.spark.length, 24);
  assert.equal(m.spark[0], 7);
  assert.equal(m.spark[23], 30);

  const huge = forecast([
    row(1, 'codex', [{ label: 'week', used: 10, resetsAt: NOW + 100 * H }]),
    row(0.5, 'codex', [{ label: 'week', used: 60, resetsAt: NOW + 100 * H }])
  ], { now: NOW }).meters[0];
  assert.equal(huge.projectedAtReset, 999);
  assert.equal(huge.verdict, 'over');
});

test('malformed rows and meters are ignored without throwing', () => {
  const reset = NOW + H;
  const history = [
    null, { ts: 'not a date', meters: { codex: [{ label: '5h', used: 1, resetsAt: reset }] } },
    { ts: iso(NOW - 2 * H), meters: null },
    { ts: iso(NOW - 2 * H), meters: { codex: [{ label: '5h', used: 10, resetsAt: reset }, null, { label: '5h', used: 'x', resetsAt: reset }] } },
    { ts: iso(NOW - H), meters: { codex: [{ label: '5h', used: 20, resetsAt: reset }, { used: 50, resetsAt: reset }] } }
  ];
  const r = forecast(history, { now: NOW });
  assert.equal(r.generatedAt, iso(NOW));
  assert.equal(r.meters.length, 1);
  assert.equal(r.meters[0].spark.length, 2);
  assert.deepEqual(forecast(null, { now: NOW }), { generatedAt: iso(NOW), meters: [] });
});
