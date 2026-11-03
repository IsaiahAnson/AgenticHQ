'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const pulse = require('../lib/pulse.cjs');

const TZ = 'America/New_York';
// 2026-10-28 15:00 New York (EDT, UTC-4)
const NOW = Date.parse('2026-10-28T19:00:00Z');
const at = s => Date.parse(s);
const days = pulse.lastDays(NOW, TZ);

test('lastDays ends today in New York', () => {
  assert.deepEqual(days, ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
  // 23:30 New York on the 28th is already the 29th in UTC
  assert.equal(pulse.lastDays(at('2026-10-29T03:30:00Z'), TZ)[6], '2026-10-28');
});

test('dots: ran ok, failed, missed, not scheduled', () => {
  const runs = [
    { ts: at('2026-10-26T14:00:00Z'), ok: true },        // 26th: ok
    { ts: at('2026-10-27T14:00:00Z'), ok: false },       // 27th: failed
    { ts: at('2026-10-28T13:00:00Z'), ok: false },       // 28th: failed, then ok later the same day
    { ts: at('2026-10-28T15:00:00Z'), ok: true }
  ];
  // expected Monday to Friday only
  const expected = day => ![0, 6].includes(new Date(day + 'T12:00:00Z').getUTCDay());
  assert.deepEqual(pulse.dayStrip({ days, runs, expected, tz: TZ }),
    ['miss', 'miss', 'none', 'none', 'ok', 'fail', 'ok']);
});

test('dots: an expected day before run history began is unknown, not missed', () => {
  const strip = pulse.dayStrip({ days, runs: [], expected: () => true, since: at('2026-10-27T12:00:00Z'), tz: TZ });
  assert.deepEqual(strip, ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'miss', 'miss']);
});

test('cronExpected: today only counts fires that are 30 min old', () => {
  const daily = pulse.cronExpected('30 14 * * *', TZ, NOW);           // 14:30 NY, now 15:00 NY
  assert.equal(daily('2026-10-28'), true);
  assert.equal(pulse.cronExpected('45 14 * * *', TZ, NOW)('2026-10-28'), false);
  const weekly = pulse.cronExpected('0 18 * * 0', TZ, NOW);            // Sundays
  assert.equal(weekly('2026-10-25'), true);
  assert.equal(weekly('2026-10-26'), false);
  assert.equal(pulse.cronExpected(null, TZ, NOW)('2026-10-26'), false);
});

test('kept ratio: opened vs trashed in the last 14 days', () => {
  const reports = [
    { file: 'r-20261027.html', at: at('2026-10-27T12:00:00Z'), trashed: false },  // opened: kept
    { file: 'r-20261026.html', at: at('2026-10-26T12:00:00Z'), trashed: false },  // never opened after tracking began
    { file: 'r-20261025.html', at: at('2026-10-25T12:00:00Z'), trashed: true },
    { file: 'r-20261020.html', at: at('2026-10-20T12:00:00Z'), trashed: false },  // before tracking: counts as kept
    { file: 'r-20261001.html', at: at('2026-10-01T12:00:00Z'), trashed: false }   // older than 14 days: ignored
  ];
  const opens = [{ file: 'r-20261027.html', ts: at('2026-10-25T00:00:00Z') }, { file: 'r-20261027.html', ts: at('2026-10-28T00:00:00Z') }];
  assert.deepEqual(pulse.keptRatio(reports, opens, { now: NOW }), { kept: 2, total: 4, trashed: 1, opened: 1 });
  // with no open tracking yet, anything still on the ring is kept
  assert.deepEqual(pulse.keptRatio(reports, [], { now: NOW }), { kept: 3, total: 4, trashed: 1, opened: 0 });
  assert.equal(pulse.keptRatio([], [], { now: NOW }), null);
});

test('noisy: the last 5 reports were all trashed', () => {
  const mk = (n, trashed) => ({ file: `x-${n}.html`, at: NOW - n * 3600e3, trashed });
  assert.equal(pulse.isNoisy([1, 2, 3, 4, 5].map(n => mk(n, true))), true);
  assert.equal(pulse.isNoisy([1, 2, 3, 4, 5, 6].map(n => mk(n, n !== 6))), true, 'an older kept one does not matter');
  assert.equal(pulse.isNoisy([1, 2, 3, 4, 5].map(n => mk(n, n !== 1))), false, 'the newest was kept');
  assert.equal(pulse.isNoisy([1, 2, 3, 4].map(n => mk(n, true))), false, 'fewer than 5 reports');
});

test('sort: problems today first, then lowest kept ratio, then the rest', () => {
  const row = (name, today, useful) => ({ name, dots: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', today], useful });
  const rows = [
    row('fine-no-reports', 'ok', null),
    row('half-kept', 'ok', { kept: 1, total: 2 }),
    row('missed-today', 'miss', { kept: 5, total: 5 }),
    row('rarely-kept', 'ok', { kept: 1, total: 6 }),
    row('failed-today', 'fail', null),
    row('quiet', 'none', null)
  ];
  assert.deepEqual(pulse.sortRows(rows).map(r => r.name),
    ['missed-today', 'failed-today', 'rarely-kept', 'half-kept', 'fine-no-reports', 'quiet']);
});

test('classifyRows marks retired deck cards and truly quiet automations', () => {
  const rows = pulse.classifyRows([
    { id:'deck-deps-check', kind:'deck', useful:null, dots:['ok'], lastRun:{ ok:true } },
    { id:'deck-current', kind:'deck', useful:null, dots:['ok','none'], lastRun:null },
    { id:'windows-alert', kind:'windows', useful:null, dots:['ok','fail'], lastRun:{ ok:false } },
    { id:'desktop-report', kind:'desktop', useful:{ kept:1, total:1 }, dots:['ok'], lastRun:{ ok:true } },
    { id:'deck-apply-comments', kind:'deck', useful:null, dots:['none'], lastRun:null }
  ], ['current']);
  assert.deepEqual(rows.map(r => [r.retired, r.retiredInto, r.quiet]), [
    [true, 'Weekly Dev Health', false], [false, null, true], [false, null, false], [false, null, false], [false, null, true]
  ]);
});

test('installer triggers and report keys', () => {
  assert.equal(pulse.triggerCron('(Every 2)'), '0 */2 * * *');
  assert.equal(pulse.triggerCron('(Every 1)'), '0 * * * *');
  assert.equal(pulse.triggerCron("(Daily '02:30')"), '30 2 * * *');
  assert.equal(pulse.triggerCron("(Weekly @('Monday','Wednesday','Friday') '19:00')"), '0 19 * * 1,3,5');
  assert.equal(pulse.triggerCron("(Weekly Sunday '18:00')"), '0 18 * * 0');
  assert.equal(pulse.triggerCron('$logon'), null);
  assert.equal(pulse.reportKey('tools\\run-card.mjs session-lessons --ingest'), 'session-lessons');
  assert.equal(pulse.reportKey('tools\\attention.mjs digest'), 'attention-digest');
  assert.equal(pulse.reportKey('tools\\hq-sentinel.mjs pc'), null);
  assert.equal(pulse.stackOf('api-hq-review-20261028-2259.html'), 'api-hq-review');
  assert.equal(pulse.stackOf('attention-digest-2026-10-28.html'), 'attention-digest');
  assert.equal(pulse.stackOf('change-watchdog.html'), 'change-watchdog');
});

test('collect: rows from tasks, desktop routines and deck runs, with reports and opens', () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-pulse-'));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(kit, rel)), { recursive: true }); fs.writeFileSync(path.join(kit, rel), body); };
  const jl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  w('config/automations.json', JSON.stringify({ windowsTasks: { jobs: { 'Agentic HQ PC Sentinel': {}, 'Agentic HQ Session Lessons': {} } }, desktopRoutines: { 'change-watchdog': {} } }));
  w('os-config.json', JSON.stringify({ skills: [{ id:'api-hq-review' }] }));
  w('tools/install-hq-routines.ps1', [
    "@{ Name = 'Agentic HQ PC Sentinel';        Args = 'tools\\hq-sentinel.mjs pc';                       Trigger = (Every 2);                    Limit = 5 },",
    "@{ Name = 'Agentic HQ Session Lessons';    Args = 'tools\\run-card.mjs session-lessons --ingest';    Trigger = (Daily '02:30');              Limit = 20 },"
  ].join('\n'));
  w('os-runs/sentinel.jsonl', jl([
    { ts: '2026-10-27T14:00:00Z', mode: 'pc', results: [] },
    { ts: '2026-10-28T14:00:00Z', mode: 'missed', results: [{ id: 'routine-missed:windows-agentic-hq-session-lessons', data: { id: 'windows-agentic-hq-session-lessons', lastRunAt: '2026-10-28T06:31:00Z', lastExpected: '2026-10-28T06:30:00Z', lastResult: 1 } }] },
    { ts: '2026-10-28T16:00:00Z', mode: 'pc', results: [] }
  ]));
  w('os-runs/routine-outcomes.jsonl', jl([{ ts: '2026-10-28T12:05:00Z', routine: 'api-hq-review', status: 'done', source: 'deck' }]));
  w('os-runs/api-hq-review-' + at('2026-10-28T12:00:00Z') + '.log', 'ran');
  w('os-runs/session-lessons-' + at('2026-10-27T06:30:00Z') + '.log', 'ran');
  for (const n of ['0900', '1000', '1100', '1200', '1300']) w(`artifacts/_trash/api-hq-review-20261028-${n}.html`, '<title>r</title>');
  w('artifacts/api-hq-review-20261028-0800.html', '<title>r</title>');
  w('data/artifact-opens.jsonl', jl([{ ts: '2026-10-20T00:00:00Z', file: 'other.html' }]));

  const routines = [{ id: 'rt:hq-pc-sentinel', status: 'active', cron: '0 */2 * * *' }, { id: 'rt:hq-session-lessons', status: 'active', cron: '30 2 * * *' },
    { id: 'rt:task-change-watchdog', name: 'Change watchdog', source: 'agent-tasks', status: 'active', cron: '0 22 * * *', lastRunAt: '2026-10-27T02:00:05Z' }];
  const d = pulse.collect({ kit, now: NOW, tz: TZ, routines });
  const by = Object.fromEntries(d.rows.map(r => [r.id, r]));

  assert.deepEqual(by['windows-agentic-hq-pc-sentinel'].dots.slice(-2), ['ok', 'ok']);
  assert.equal(by['windows-agentic-hq-pc-sentinel'].useful, null);
  // Session Lessons: Task Scheduler said the 28th's run failed (lastResult 1); the 27th has a deck log
  assert.deepEqual(by['windows-agentic-hq-session-lessons'].dots.slice(-2), ['ok', 'fail']);
  assert.match(by['windows-agentic-hq-session-lessons'].open, /^\/api\/pulse\/log\?file=session-lessons-/);
  // change-watchdog: ran the night of the 26th, missed the 27th; 22:00 today isn't due yet
  assert.deepEqual(by['desktop-change-watchdog'].dots.slice(-3), ['ok', 'miss', 'none']);
  // api-hq-review: 6 reports, the 5 newest trashed, the one left was never opened after tracking began
  const api = by['deck-api-hq-review'];
  assert.deepEqual(api.useful, { kept: 0, total: 6, trashed: 5, opened: 0 });
  assert.equal(api.noisy, true);
  assert.equal(api.open, '/artifacts/api-hq-review-20261028-0800.html');
  // the failed Session Lessons sorts first
  assert.equal(d.rows[0].id, 'windows-agentic-hq-session-lessons');
});
