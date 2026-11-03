'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const attention = require('../lib/attention.cjs');

// 2026-10-28 10:00 New York (EDT, UTC-4)
const T0 = Date.parse('2026-10-28T14:00:00Z');
function rig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-attention-'));
  const calls = [], events = [];
  const opts = {
    dir, artifactsDir: path.join(dir, 'artifacts'), now: T0, config: { dailyPushes: 3 },
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { ok: true, status: 200 }; },
    onEvent: ev => events.push(ev), ...extra
  };
  return { dir, calls, events, opts, at: now => ({ ...opts, now }) };
}
const held = dir => { try { return fs.readFileSync(path.join(dir, 'attention-digest.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };

test('4th normal push in a day is held for the digest', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) assert.equal((await attention.notify({ source: 's', title: `t${i}` }, r.at(T0 + i))).sent, true);
  const fourth = await attention.notify({ source: 's', title: 't3' }, r.at(T0 + 3));
  assert.deepEqual([fourth.sent, fourth.held, fourth.reason], [false, true, 'over-budget']);
  assert.equal(r.calls.length, 3);
  assert.equal(held(r.dir)[0].title, 't3');
});

test('urgent still sends after the budget is spent, and counts', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) await attention.notify({ source: 's', title: `t${i}` }, r.at(T0 + i));
  const urgent = await attention.notify({ source: 'sentinel:boot', title: 'HQ down', priority: 'urgent' }, r.at(T0 + 9));
  assert.equal(urgent.sent, true);
  assert.equal(r.calls.at(-1).body.priority, 5);
  assert.equal(attention.status(r.at(T0 + 10)).sent, 4);
});

test('low never sends', async () => {
  const r = rig();
  const low = await attention.notify({ source: 's', title: 'fyi', priority: 'low' }, r.opts);
  assert.deepEqual([low.sent, low.reason], [false, 'low']);
  assert.equal(r.calls.length, 0);
  assert.equal(held(r.dir).length, 1);
});

test('the day boundary resets at midnight America/New_York, not UTC', async () => {
  const r = rig();
  const lateNY = Date.parse('2026-10-29T03:30:00Z'); // 23:30 on the 28th in New York, already the 29th in UTC
  for (let i = 0; i < 3; i++) await attention.notify({ source: 's', title: `t${i}` }, r.at(T0 + i));
  assert.equal((await attention.notify({ source: 's', title: 'late' }, r.at(lateNY))).reason, 'over-budget');
  const nextDay = Date.parse('2026-10-29T04:05:00Z'); // 00:05 on the 29th in New York
  assert.equal((await attention.notify({ source: 's', title: 'morning' }, r.at(nextDay))).sent, true);
  assert.equal(attention.localDay(nextDay), '2026-10-29');
});

test('same key within 24 h is dropped, after 24 h it sends again', async () => {
  const r = rig();
  assert.equal((await attention.notify({ source: 's', title: 'x', key: 'k1' }, r.at(T0))).sent, true);
  assert.equal((await attention.notify({ source: 's', title: 'x', key: 'k1' }, r.at(T0 + 3600e3))).reason, 'duplicate');
  assert.equal((await attention.notify({ source: 's', title: 'x', key: 'k1' }, r.at(T0 + 25 * 3600e3))).sent, true);
  assert.equal(r.calls.length, 2);
});

test('every sent push has a Dismiss http action and keeps its click link', async () => {
  const r = rig();
  await attention.notify({ source: 's', title: 'x', key: 'abc', click: 'http://localhost:50000/artifacts/a.html' }, r.opts);
  const [action] = r.calls[0].body.actions;
  assert.deepEqual([action.action, action.label, action.method], ['http', 'Dismiss', 'POST']);
  assert.match(action.url, /\/local\/attention\/dismiss\?key=abc$/);
  assert.equal(r.calls[0].body.click, 'http://localhost:50000/artifacts/a.html');
});

test('5 dismissals demote a source; unmute restores it', async () => {
  const r = rig({ config: { dailyPushes: 99 } });
  for (let i = 0; i < 5; i++) {
    const { key } = await attention.notify({ source: 'feeds', title: `item ${i}` }, r.at(T0 + i));
    const d = attention.dismiss(key, r.at(T0 + i));
    assert.equal(d.demoted, i === 4);
  }
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].key, 'attention.demoted:feeds');
  const muted = await attention.notify({ source: 'feeds', title: 'item 6' }, r.at(T0 + 10));
  assert.deepEqual([muted.sent, muted.reason], [false, 'muted']);
  assert.equal(held(r.dir).at(-1).priority, 'low');
  const urgent = await attention.notify({ source: 'feeds', title: 'urgent item', priority: 'urgent' }, r.at(T0 + 11));
  assert.equal(urgent.sent, true);

  assert.equal(attention.unmute('feeds', r.opts).ok, true);
  assert.equal((await attention.notify({ source: 'feeds', title: 'item 7' }, r.at(T0 + 12))).sent, true);
});

test('four dismissals and one ignored push do not demote', async () => {
  const r = rig({ config: { dailyPushes: 99 } });
  for (let i = 0; i < 5; i++) {
    const { key } = await attention.notify({ source: 'builds', title: `build ${i}` }, r.at(T0 + i));
    if (i !== 2) attention.dismiss(key, r.at(T0 + i));
  }
  assert.equal(r.events.length, 0);
  assert.equal((await attention.notify({ source: 'builds', title: 'build 6' }, r.at(T0 + 9))).sent, true);
});

test('digest groups held items, writes a ring report and does not count', async () => {
  const r = rig({ config: { dailyPushes: 0 } });
  await attention.notify({ source: 'feeds', title: 'a' }, r.at(T0));
  await attention.notify({ source: 'feeds', title: 'b' }, r.at(T0 + 1));
  await attention.notify({ source: 'sentinel:pc', title: 'disk', priority: 'low' }, r.at(T0 + 2));
  const digest = attention.buildDigest(held(r.dir));
  assert.equal(digest.title, 'HQ today: 3 items');
  assert.deepEqual(digest.groups.map(g => [g.source, g.items.length]), [['feeds', 2], ['sentinel:pc', 1]]);

  const dry = await attention.runDigest({ ...r.at(T0 + 6 * 3600e3), dryRun: true });
  assert.equal(dry.push.title, 'HQ today: 3 items');
  assert.equal(r.calls.length, 0);
  const run = await attention.runDigest(r.at(T0 + 6 * 3600e3));
  assert.equal(run.count, 3);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].body.click, /attention-digest-2026-10-28\.html$/);
  const sidecar = JSON.parse(fs.readFileSync(path.join(r.opts.artifactsDir, 'attention-digest-2026-10-28.json'), 'utf8'));
  assert.equal(sidecar.kind, 'report');
  assert.equal(attention.status(r.at(T0 + 6 * 3600e3)).sent, 0);
  // already digested: the next run has nothing new
  assert.equal((await attention.runDigest(r.at(T0 + 7 * 3600e3))).skipped, true);
});

test('digest shows a push held again as one row with a count', async () => {
  const r = rig({ config: { dailyPushes: 0 } });
  await attention.notify({ source: 'sentinel:pc', title: 'Disk low', text: 'C: 9% free' }, r.at(T0));
  await attention.notify({ source: 'sentinel:pc', title: 'disk LOW!', text: 'C: 9% free' }, r.at(T0 + 1));
  await attention.notify({ source: 'sentinel:pc', title: 'Disk low', text: 'C: 8% free' }, r.at(T0 + 2));
  const digest = attention.buildDigest(held(r.dir));
  assert.equal(digest.count, 3, 'count is every held push');
  assert.equal(digest.title, 'HQ today: 2 items');
  assert.deepEqual(digest.groups[0].items.map(i => [i.text, i.repeats]), [['C: 9% free', 2], ['C: 8% free', 1]]);
  assert.match(digest.lines[0], /^sentinel:pc \(2\)/);
});

test('digest is skipped when nothing was held', async () => {
  const r = rig();
  await attention.notify({ source: 's', title: 'sent fine' }, r.opts);
  const result = await attention.runDigest(r.at(T0 + 3600e3));
  assert.equal(result.skipped, true);
  assert.equal(r.calls.length, 1);
});

test('click links are http(s) only', async () => {
  const r = rig();
  await attention.notify({ source: 'x', title: 'bad', priority: 'urgent', key: 'k1', click: 'javascript:alert(1)' }, r.opts);
  await attention.notify({ source: 'x', title: 'good', priority: 'urgent', key: 'k2', click: 'http://localhost:50000/artifacts/a.html' }, r.opts);
  assert.equal(r.calls[0].body.click, undefined);
  assert.equal(r.calls[1].body.click, 'http://localhost:50000/artifacts/a.html');
});
