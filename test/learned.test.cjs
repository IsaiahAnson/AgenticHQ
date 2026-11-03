'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const learned = require('../lib/learned.cjs');
const gotchas = require('../lib/gotcha-proposals.cjs');

const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-28T23:00:00Z');   // Wed 19:00 New York
const DAY = 864e5;

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-learned-'));
  const w = (rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };
  return { root, w };
}
const LESSON = '- **Quote any run() argument that has spaces in it** because the Windows shell splits it (verified 2026-10-28) [ref: abc, 2026-10-28]';

test('lesson counts: last "Lessons:" line of each run this week', () => {
  const runs = [
    { ts: NOW - DAY, text: 'notes\nLessons: 1 added, 0 updated, 0 superseded.\n**Lessons:** 8 added, 3 updated, 1 superseded. Next action: none' },
    { ts: NOW - 2 * DAY, text: 'Lessons: 0 added, 4 updated, 0 superseded.' },
    { ts: NOW - 9 * DAY, text: 'Lessons: 50 added, 0 updated, 0 superseded.' },   // last week
    { ts: NOW - DAY, text: 'crashed before the summary' }
  ];
  assert.deepEqual(learned.lessonCounts(runs, { now: NOW }), { added: 8, updated: 7, superseded: 1, runs: 2 });
});

test('newest lessons: verified date, then file edit time, then later lines; superseded skipped', () => {
  const a = learned.parseLessons(['# HQ', '- **Old rule** (verified 2026-10-20)', '- ~~**Superseded rule**~~ (verified 2026-10-28)', '- **Late rule.** (verified 2026-10-28)'].join('\n'), 'hq', 100);
  const b = learned.parseLessons(['- **Other topic rule** (verified 2026-10-28)', '- **No date rule**'].join('\n'), 'pc', 200);
  assert.equal(a.length, 2, 'the struck-through lesson is not counted');
  assert.deepEqual(learned.newestLessons([...a, ...b], 3).map(l => l.title), ['Other topic rule', 'Late rule', 'Old rule']);
});

test('proposal counts: pending, approved all time and this week', () => {
  const state = { proposals: [
    { id: 'a', skill: 'reason', text: '- Rule A.', status: 'proposed', recurrence: 1, proposedAt: '2026-10-28T20:00:00Z', source: ['C:\\k\\lessons\\music-reason.md:4'] },
    { id: 'b', skill: 'agenticos', text: '- Rule B.', status: 'proposed', recurrence: 3, proposedAt: '2026-10-27T20:00:00Z', source: [] },
    { id: 'c', skill: 'agenticos', status: 'applied', appliedAt: '2026-10-27T10:00:00Z' },
    { id: 'd', skill: 'agenticos', status: 'applied', appliedAt: '2026-10-01T10:00:00Z' },
    { id: 'e', skill: 'reason', status: 'rejected' }
  ] };
  const pending = learned.pendingProposals(state);
  assert.deepEqual(pending.map(p => p.id), ['b', 'a'], 'higher recurrence first');
  assert.equal(pending[1].text, 'Rule A.');
  assert.equal(pending[1].topic, 'music-reason');
  assert.deepEqual(pending[0].assessment, {
    why: 'Agents hit this 3x; the rule stops it repeating.', timeSaved: 'monthly', effort: 'approve',
    timeReason: 'Estimated from 3 recurrences per month.', effortReason: 'The rule itself is the durable fix.', by: 'auto',
    timeLabel: '~30m/mo saved', effortLabel: 'Approve only'
  });
  state.proposals[0].assessment = { why: 'Stored reason.', timeSaved: 'weekly', effort: 'large', timeReason: 'Often.', effortReason: 'Architecture.', by: 'reviewer', at: '2026-10-29T00:00:00Z' };
  assert.deepEqual(learned.pendingProposals(state).find(p => p.id === 'a').assessment, {
    ...state.proposals[0].assessment, timeLabel: '~2h/mo saved', effortLabel: 'Large build'
  });
  assert.deepEqual(learned.approvedCounts(state, { now: NOW }), { allTime: 2, thisWeek: 1, dismissed: 1 });
});

test('next proposals run: daily at 19:00', () => {
  assert.deepEqual(learned.nextFire('0 19 * * *', TZ, NOW + 60000), { day: '2026-10-29', minutes: 1140 });
  assert.deepEqual(learned.nextFire('0 19 * * *', TZ, NOW - 3600e3), { day: '2026-10-28', minutes: 1140 });
});

test('approve writes the patch exactly once', () => {
  const { root, w } = rig();
  const skillsRoot = path.join(root, 'skills');
  const skill = w('skills/demo/SKILL.md', '# demo\n\nSteps.\n\n## Gotchas\n\n- Existing gotcha.\n');
  const dataFile = w('data/gotcha-proposals.json', JSON.stringify({ version: 1, proposals: [{ id: 'p1', skill: 'demo', file: skill, section: 'Gotchas', text: '- Quote any run() argument that has spaces in it.', status: 'proposed' }] }));
  const r = gotchas.applyProposals({ ids: ['p1'], dataFile, skillsRoot, commit: false, now: new Date(NOW) });
  assert.equal(r.applied[0].duplicate, false);
  assert.throws(() => gotchas.applyProposals({ ids: ['p1'], dataFile, skillsRoot, commit: false }), /is applied/);
  const body = fs.readFileSync(skill, 'utf8');
  assert.equal(body.split('Quote any run() argument').length - 1, 1);
  assert.match(body, /## Gotchas\n\n- Existing gotcha\.\n- Quote any run\(\) argument/);
  const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(state.proposals[0].status, 'applied');
  assert.equal(learned.approvedCounts(state, { now: NOW }).thisWeek, 1);
});

test('plugin skill paths are refused', () => {
  const { root, w } = rig();
  const skillsRoot = path.join(root, 'skills');
  w('skills/demo/SKILL.md', '# demo\n');
  const plugin = w('plugins/cache/some-plugin/skills/demo/SKILL.md', '# plugin skill\n');
  const dataFile = w('data/gotcha-proposals.json', JSON.stringify({ proposals: [
    { id: 'p2', skill: 'demo', file: plugin, text: '- Plugin rule.', status: 'proposed' },
    { id: 'p3', skill: '../plugins/cache/some-plugin/skills/demo', file: plugin, text: '- Escape rule.', status: 'proposed' }
  ] }));
  assert.throws(() => gotchas.applyProposals({ ids: ['p2'], dataFile, skillsRoot, commit: false }), /outside the personal skills root/);
  assert.throws(() => gotchas.applyProposals({ ids: ['p3'], dataFile, skillsRoot, commit: false }), /outside the personal skills root/);
  assert.equal(fs.readFileSync(plugin, 'utf8'), '# plugin skill\n');
});

test('trash marks it dismissed and the proposer never raises it again', () => {
  const { root, w } = rig();
  const skillsRoot = path.join(root, 'skills');
  w('skills/demo/SKILL.md', '# demo\n\n## Gotchas\n');
  w('lessons/demo-topic.md', '# Demo\n\n' + LESSON + '\n');
  const args = { lessonsDir: path.join(root, 'lessons'), registryFile: path.join(root, 'none.md'), skillsRoot, lessonSkillMap: { 'demo-topic': ['demo'] } };
  const first = gotchas.candidateProposals({ ...args, existing: [] });
  assert.equal(first.length, 1);
  const dataFile = w('data/gotcha-proposals.json', JSON.stringify({ version: 1, proposals: [{ ...first[0], report: 'r.html' }] }));
  assert.deepEqual(gotchas.dismissProposals({ ids: [first[0].id], dataFile }).dismissed, [{ id: first[0].id, skill: 'demo' }]);
  const state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(state.proposals[0].status, 'rejected');
  assert.equal(gotchas.candidateProposals({ ...args, existing: state.proposals }).length, 0);
  assert.throws(() => gotchas.dismissProposals({ ids: [first[0].id], dataFile }), /is rejected/);
  assert.throws(() => gotchas.applyProposals({ ids: [first[0].id], dataFile, skillsRoot, commit: false }), /is rejected/);
  assert.throws(() => gotchas.dismissProposals({ ids: ['nope'], dataFile }), /Unknown proposal/);
});

test('collect: week, newest, pending and next run from files', () => {
  const { root, w } = rig();
  w('os-runs/session-lessons-' + (NOW - DAY) + '.log', 'Lessons: 2 added, 1 updated, 0 superseded.');
  w('lessons/hq.md', LESSON + '\n');
  w('lessons/README.md', '- **not a lesson**\n');
  w('data/gotcha-proposals.json', JSON.stringify({ lastRunAt: '2026-10-28T23:00:00Z', proposals: [{ id: 'x', skill: 'agenticos', text: '- Rule X.', status: 'proposed' }] }));
  w('tools/install-hq-routines.ps1', "@{ Name = 'Agentic HQ Gotcha Proposals'; Args = 'tools\\run-card.mjs gotcha-proposals'; Trigger = (Daily '19:00'); Limit = 20 },");
  const d = learned.collect({ kit: root, lessonsDir: path.join(root, 'lessons'), now: NOW + 60000, tz: TZ });
  assert.deepEqual([d.week.added, d.week.updated, d.week.superseded, d.week.total], [2, 1, 0, 1]);
  assert.deepEqual(d.week.filesTouched, ['hq']);
  assert.equal(d.newest[0].title, 'Quote any run() argument that has spaces in it');
  assert.deepEqual(d.pending.map(p => p.id), ['x']);
  assert.deepEqual(d.nextProposals, { day: '2026-10-29', time: '19:00', cron: '0 19 * * *' });
});
