'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { sinceItems } = require('../lib/since.cjs');

const H = 36e5;
const NOW = Date.parse('2026-10-28T18:00:00Z');
const iso = ms => new Date(ms).toISOString();

test('defaults to the last 12 hours and echoes the window start', () => {
  const r = sinceItems({
    now: NOW,
    events: [
      { ts: iso(NOW - 13 * H), type: 'run.done', source: 'old', severity: 'info', key: 'k1', summary: 'too old' },
      { ts: iso(NOW - 11 * H), type: 'run.done', source: 'new', severity: 'info', key: 'k2', summary: 'inside' }
    ]
  });
  assert.equal(r.since, iso(NOW - 12 * H));
  assert.deepEqual(r.items.map(i => i.text), ['inside']);
  assert.equal(r.items[0].at, iso(NOW - 11 * H));
  assert.equal(r.items[0].target, 'automations');
  assert.equal(r.allClear, true);

  const explicit = sinceItems({ lastSeen: iso(NOW - 6 * H), now: NOW, events: [
    { ts: iso(NOW - 7 * H), type: 'a.b', source: 's', severity: 'info', summary: 'gone' },
    { ts: iso(NOW - 5 * H), type: 'a.b', source: 's', severity: 'info', summary: 'kept' }
  ] });
  assert.equal(explicit.since, iso(NOW - 6 * H));
  assert.deepEqual(explicit.items.map(i => i.text), ['kept']);
  assert.equal(sinceItems({ lastSeen: NOW - 3 * H, now: NOW, events: [] }).since, iso(NOW - 3 * H));
});

test('a down and a later up on one source collapse into one warn item', () => {
  const r = sinceItems({
    now: NOW,
    events: [
      { ts: iso(NOW - 5 * H), type: 'api.down', source: 'api', severity: 'error', key: 'api.down', summary: 'api is down' },
      { ts: iso(NOW - 4 * H), type: 'api.up', source: 'api', severity: 'info', key: 'api.up', summary: 'api is up' },
      { ts: iso(NOW - 3 * H), type: 'nightly.failed', source: 'nightly', severity: 'warn', key: 'n', summary: 'nightly failed' }
    ]
  });
  assert.deepEqual(r.items.map(i => i.text), ['nightly failed', 'api went down and came back']);
  assert.deepEqual(r.items.map(i => i.severity), ['warn', 'warn']);
  assert.equal(r.items[1].at, iso(NOW - 4 * H), 'the collapse is stamped when it came back');
  assert.equal(r.items[1].kind, 'outage');
  assert.equal(r.counts.bad, 0);
  assert.equal(r.allClear, false);
});

test('a bad-severity event counts as down; a down with no up stays bad', () => {
  const r = sinceItems({
    now: NOW,
    events: [
      { ts: iso(NOW - 6 * H), type: 'build.stuck', source: 'build', severity: 'critical', summary: 'build stuck' },
      { ts: iso(NOW - 5 * H), type: 'build.up', source: 'build', severity: 'info', summary: 'build back' },
      { ts: iso(NOW - 2 * H), type: 'db.down', source: 'db', severity: 'error', summary: 'db down' }
    ]
  });
  assert.deepEqual(r.items.map(i => i.text), ['db down', 'build went down and came back']);
  assert.deepEqual(r.items.map(i => i.severity), ['bad', 'warn']);
  assert.equal(r.counts.bad, 1);
});

test('new ring pages group into one line and agent-monitor.html is excluded', () => {
  const r = sinceItems({
    now: NOW,
    artifacts: [
      { file: 'agent-monitor.html', title: 'Agent monitor', created: iso(NOW - H) },
      { file: 'a.html', title: 'A page', created: iso(NOW - 2 * H) },
      { file: 'b.html', title: 'B page', created: iso(NOW - 3 * H) },
      { file: 'c.html', title: 'C page', created: iso(NOW - 4 * H) },
      { file: 'old.html', title: 'Old page', created: iso(NOW - 20 * H) }
    ]
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, '3 new pages on the ring: A page, B page');
  assert.equal(r.items[0].target, 'ring');
  assert.equal(r.items[0].severity, 'info');
  assert.equal(r.items[0].at, iso(NOW - 2 * H));
});

test('outcomes: failures and asks stand alone, successes roll into one good line', () => {
  const r = sinceItems({
    now: NOW,
    outcomes: [
      { source: 'deps', status: 'failed', endedAt: iso(NOW - 2 * H) },
      { source: 'radar', status: 'needs-action', endedAt: iso(NOW - 3 * H), next: 'pick a build' },
      { source: 'a', status: 'succeeded', endedAt: iso(NOW - H) },
      { source: 'b', status: 'succeeded', endedAt: iso(NOW - 4 * H) },
      { source: 'old', status: 'succeeded', endedAt: iso(NOW - 30 * H) }
    ]
  });
  assert.deepEqual(r.items.map(i => i.text), ['deps failed', 'radar needs you: pick a build', '2 runs finished fine']);
  assert.deepEqual(r.items.map(i => i.severity), ['bad', 'warn', 'good']);
  assert.deepEqual(r.counts, { bad: 1, warn: 1, good: 1, info: 0 });
  assert.equal(r.items[2].at, iso(NOW - H));
});

test('the cap of 8 keeps counts from before the cut', () => {
  const events = [];
  for (let i = 1; i <= 10; i++) events.push({ ts: iso(NOW - i * H), type: 'tick', source: 'tick', severity: 'info', summary: 'tick ' + i });
  events.push({ ts: iso(NOW - 2 * H), type: 'x.failed', source: 'x', severity: 'error', summary: 'x failed' });
  events.push({ ts: iso(NOW - 10 * H), type: 'y.failed', source: 'y', severity: 'error', summary: 'y failed' });
  const r = sinceItems({ now: NOW, events });
  assert.equal(r.items.length, 8);
  assert.deepEqual(r.counts, { bad: 2, warn: 0, good: 0, info: 10 });
  assert.deepEqual(r.items.map(i => i.rank), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(r.items.slice(0, 2).map(i => i.text), ['x failed', 'y failed']);
  assert.deepEqual(r.items.slice(2).map(i => i.text), ['tick 1', 'tick 2', 'tick 3', 'tick 4', 'tick 5', 'tick 6']);
});

test('email counts only, youtube deltas, tracker updates and radar findings', () => {
  const r = sinceItems({
    now: NOW,
    email: { unread: 12, subject: 'SECRET SUBJECT', from: 'boss@example.com' },
    emailPrev: { unread: 9 },
    youtube: [{ ts: iso(NOW - 20 * H), subs: 100, views: 5000 }, { ts: iso(NOW - 2 * H), subs: 103, views: 5120 }],
    jobs: [{ at: iso(NOW - H), title: 'Item A', status: 'open' }, { at: iso(NOW - 5 * H), title: 'Item B', status: 'review' }],
    radar: { generatedAt: iso(NOW - 2 * H), findings: [{ verdict: 'adopt' }, { verdict: 'trial' }, { verdict: 'skip' }] }
  });
  const byText = Object.fromEntries(r.items.map(i => [i.text, i]));
  assert.equal(byText['3 new emails'].target, 'email');
  assert.equal(byText['3 new emails'].severity, 'info');
  assert.equal(byText['+3 subs, +120 views'].target, 'youtube');
  assert.equal(byText['+3 subs, +120 views'].severity, 'good');
  assert.equal(byText['2 tracker updates'].target, 'jobs');
  assert.equal(byText['Radar: 2 worth trying'].target, 'radar');
  assert.equal(byText['Radar: 2 worth trying'].severity, 'good');
  assert.ok(!JSON.stringify(r).includes('SECRET'), 'email subjects never reach the text');
  assert.ok(!JSON.stringify(r).includes('boss@example.com'), 'senders never reach the text');
});

test('allClear when only good and info, not when anything is warn or bad', () => {
  const quiet = sinceItems({ now: NOW, email: { unread: 4 }, emailPrev: { unread: 2 } });
  assert.equal(quiet.allClear, true);
  const noisy = sinceItems({ now: NOW, outcomes: [{ source: 'x', status: 'needs-action', endedAt: iso(NOW - H), next: 'look' }] });
  assert.equal(noisy.allClear, false);
});

test('the same alert twice shows once with a count', () => {
  const now = Date.parse('2026-10-31T12:00:00Z');
  const ev = h => ({ ts: new Date(now - h * 3600e3).toISOString(), type: 'usage.warn', source: 'usage', severity: 'warn', summary: 'Codex week window reached 89%' });
  const r = sinceItems({ lastSeen: now - 6 * 3600e3, now, events: [ev(1), ev(2)] });
  assert.deepEqual(r.items.map(i => i.text), ['Codex week window reached 89% (x2)']);
  assert.equal(r.counts.warn, 2);
});
