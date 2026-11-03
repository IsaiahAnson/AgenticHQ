'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const today = require('../lib/today.cjs');

const NOW = Date.parse('2026-10-30T16:00:00Z');

test('nextActions keeps the newest recent non-empty action per routine', () => {
  const lines = [
    '{bad',
    { ts:'2026-10-29T11:00:00-04:00', routine:'review', next:'old step' },
    { ts:'2026-10-30T09:15:00-04:00', routine:'review', next:'Send the summary' },
    { ts:'2026-10-30T14:00:00Z', routine:'health', next:'  Restart the probe  ' },
    { ts:'2026-10-30T15:00:00Z', routine:'empty', next:' ' }
  ].map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('\n');
  assert.deepEqual(today.nextActions(lines, { now:NOW }), [
    { routine:'health', text:'Restart the probe', ts:'2026-10-30T14:00:00.000Z' },
    { routine:'review', text:'Send the summary', ts:'2026-10-30T13:15:00.000Z' }
  ]);
});

test('jobSummary returns counts only and a seven-day application total', () => {
  const rows = [
    { applied:'2026-10-30', state:'Interview', followUpDue:true, company:'Example One', url:'https://private.invalid' },
    { applied:'2026-10-24', state:'Waiting', followUpDue:false, company:'Example Two' },
    { applied:'2026-10-23', state:'No response', followUpDue:true }
  ];
  assert.deepEqual(today.jobSummary(rows, { now:NOW, weeklyGoal:12, fileTime:'fixture' }), {
    total:3, byState:{ 'No response':1, Waiting:1, Interview:1, 'Action needed':0, Rejected:0, Closed:0 },
    followUpsDue:2, appliedLast7:2, weeklyGoal:12, lastApplied:'2026-10-30', fileTime:'fixture'
  });
});

test('getToday reads fixture files and degrades safely when the tracker is missing', () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-today-'));
  fs.mkdirSync(path.join(kit, 'os-runs'));
  fs.writeFileSync(path.join(kit, 'os-runs', 'routine-outcomes.jsonl'), JSON.stringify({ ts:'2026-10-30T10:00:00Z', routine:'fixture', next:'Do the fixture step' }) + '\n');
  const tracker = path.join(kit, 'applications.json');
  fs.writeFileSync(tracker, JSON.stringify([{ applied:'2026-10-30', state:'Action needed', followUpDue:true, company:'Private Co' }]));
  const result = today.getToday({ kit, applicationsFile:tracker, weeklyGoal:8, now:NOW });
  assert.equal(result.next[0].text, 'Do the fixture step');
  assert.equal(result.jobs.byState['Action needed'], 1);
  assert.equal(JSON.stringify(result).includes('Private Co'), false);
  assert.deepEqual(today.getToday({ kit, applicationsFile:path.join(kit, 'missing.json'), now:NOW }).jobs, { error:'no tracker' });
  assert.equal('jobs' in today.getToday({ kit, now:NOW }), false);
});
