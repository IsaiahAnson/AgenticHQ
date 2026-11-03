'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { receipts, jaccard } = require('../lib/receipts.cjs');

const NOW = Date.parse('2026-10-28T18:00:00Z');

test('token Jaccard: 4+ letter words, shared over union', () => {
  assert.equal(jaccard('Quote any run() argument that has spaces in it', 'Quote any run argument with spaces'), 0.6);
  assert.equal(jaccard('Alpha beta gamma delta', 'Alpha beta zeta eta'), 0.4);
  assert.equal(jaccard('', 'anything'), 0);
});

test('a later lesson with Jaccard >= 0.5 means the gotcha recurred, otherwise it holds', () => {
  const r = receipts({
    now: NOW,
    proposals: [
      { id: 'p1', skill: 'shell', text: 'Quote any run() argument that has spaces in it', status: 'applied', appliedAt: '2026-10-20T10:00:00Z' },
      { id: 'p2', skill: 'reason', text: 'Bounce the mix before mastering the track', status: 'applied', appliedAt: '2026-10-27T10:00:00Z' },
      { id: 'p3', skill: 'ignored', text: 'Never applied', status: 'proposed' }
    ],
    lessons: [
      { topic: 'shell', title: 'Quote any run argument with spaces', verified: '2026-10-25' },
      { topic: 'music', title: 'Unrelated deploy checklist', verified: '2026-10-26' }
    ]
  });
  assert.deepEqual(r.week, { approved: 1, recurred: 1, holding: 1, runs: 0, succeeded: 0, failed: 0 });
  assert.deepEqual(r.items, [
    { kind: 'recurred', tone: 'bad', text: 'shell: the fix you approved on 10/20 came back', target: 'learned' },
    { kind: 'holding', tone: 'good', text: 'reason: holding since 10/27', target: 'learned' }
  ]);
});

test('a lesson verified on or before the apply date does not count as recurring', () => {
  const r = receipts({
    now: NOW,
    proposals: [{ id: 'p', skill: 'demo', text: 'Always quote shell arguments with spaces', status: 'applied', appliedAt: '2026-10-27T10:00:00Z' }],
    lessons: [{ topic: 'demo', title: 'Always quote shell arguments with spaces', verified: '2026-10-27' }]
  });
  assert.equal(r.week.recurred, 0);
  assert.equal(r.week.holding, 1);
  assert.equal(r.items[0].text, 'demo: holding since 10/27');
});

test('holding items only appear for approvals inside the week; the counts cover all applied', () => {
  const r = receipts({
    now: NOW,
    proposals: [
      { id: 'old', skill: 'old', text: 'Some old approved rule', status: 'applied', appliedAt: '2026-09-01T10:00:00Z' },
      { id: 'new', skill: 'new', text: 'Some new approved rule', status: 'applied', appliedAt: '2026-10-25T10:00:00Z' }
    ]
  });
  assert.equal(r.week.approved, 1);
  assert.equal(r.week.holding, 2);
  assert.deepEqual(r.items.map(i => i.text), ['new: holding since 10/25']);
});

test('a noisy automation becomes a retire item', () => {
  const r = receipts({
    now: NOW,
    pulseRows: [
      { id: 'w1', name: 'Deps Check', noisy: true, useful: { kept: 2, total: 12 } },
      { id: 'w2', name: 'Quiet One', noisy: false, useful: { kept: 10, total: 10 } }
    ]
  });
  assert.deepEqual(r.items, [{ kind: 'retire', tone: 'warn', text: 'Deps Check: kept 2 of 12. Retire it?', target: 'automations' }]);
});

test('radar builds that are done, not built or failed wait on merge or discard', () => {
  const r = receipts({
    now: NOW,
    radarDecisions: { items: {
      a: { decision: 'implement', title: 'Try Foo', jobStatus: 'done', discarded: false },
      b: { decision: 'implement', title: 'Discarded Bar', jobStatus: 'failed', discarded: true },
      c: { decision: 'implement', title: 'Still Building', jobStatus: 'building' },
      d: { decision: 'skip', title: 'Not Chosen', jobStatus: 'done' }
    } }
  });
  assert.deepEqual(r.items, [{ kind: 'radar', tone: 'warn', text: 'Try Foo: build done. Merge or discard', target: 'radar' }]);
});

test('week run counts, tone order and the cap of 10', () => {
  const pulseRows = [];
  for (let i = 0; i < 12; i++) pulseRows.push({ id: 'w' + i, name: 'Noisy ' + i, noisy: true, useful: { kept: 1, total: 10 } });
  const r = receipts({
    now: NOW,
    proposals: [{ id: 'p', skill: 'shell', text: 'Quote any run() argument that has spaces in it', status: 'applied', appliedAt: '2026-10-22T10:00:00Z' }],
    lessons: [{ topic: 'shell', title: 'Quote any run argument with spaces', verified: '2026-10-25' }],
    pulseRows,
    outcomes: [
      { status: 'succeeded', endedAt: '2026-10-28T10:00:00Z' },
      { status: 'succeeded', endedAt: '2026-10-27T10:00:00Z' },
      { status: 'failed', endedAt: '2026-10-26T10:00:00Z' },
      { status: 'succeeded', endedAt: '2026-10-01T10:00:00Z' }
    ]
  });
  assert.deepEqual(r.week, { approved: 1, recurred: 1, holding: 0, runs: 3, succeeded: 2, failed: 1 });
  assert.equal(r.items.length, 10);
  assert.equal(r.items[0].tone, 'bad');
  assert.equal(r.items[0].kind, 'recurred');
  assert.ok(r.items.slice(1).every(i => i.tone === 'warn' && i.kind === 'retire'));
});

test('several holding fixes to one skill collapse into one row', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const proposals = [1, 2, 3].map(i => ({ id: 'p' + i, skill: 'bx', text: 'fix number ' + i, status: 'applied', appliedAt: '2026-10-29T10:00:00Z' }));
  const r = receipts({ now, proposals });
  assert.deepEqual(r.items.map(i => i.text), ['bx: 3 fixes holding since 10/29']);
  assert.equal(r.week.holding, 3);
});
