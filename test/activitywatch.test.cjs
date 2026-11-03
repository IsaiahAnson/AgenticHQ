'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { hoursByApp, categoryOf } = require('../lib/activitywatch.cjs');

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
/* one window bucket from another machine has the newest last_updated but no AFK partner: skip it */
const BUCKETS = {
  'aw-watcher-window_local': { id: 'aw-watcher-window_local', type: 'currentwindow', hostname: 'local', last_updated: '2026-10-31T11:00:00Z' },
  'aw-watcher-afk_local': { id: 'aw-watcher-afk_local', type: 'afkstatus', hostname: 'local', last_updated: '2026-10-31T11:00:00Z' },
  'aw-watcher-window_other': { id: 'aw-watcher-window_other', type: 'currentwindow', hostname: 'other-host', last_updated: '2026-10-31T12:30:00Z' }
};
const EVENTS = [
  { duration: 5400, data: { app: 'Cursor', title: 'secret-project-file.ts' } },
  { duration: 1800, data: { app: 'Google Chrome', title: 'secret-project-file.ts' } },
  { duration: 900, data: { app: 'Reason' } },
  { duration: 300, data: { app: 'Notion' } }
];

function fakeFetch({ buckets = BUCKETS, events = EVENTS, calls = [], error = null, status = null } = {}) {
  return async (url, init = {}) => {
    calls.push({ url, init });
    if (error) throw new Error(error);
    if (status) return { ok: false, status, json: async () => ({}) };
    if (String(url).endsWith('/api/0/buckets/')) return { ok: true, json: async () => buckets };
    return { ok: true, json: async () => [events] };
  };
}

test('hoursByApp sums hours per app and category and asks for not-afk window time', async () => {
  const calls = [];
  const out = await hoursByApp({ now: NOW, days: 7, fetch: fakeFetch({ calls }) });

  assert.equal(out.ok, true);
  assert.equal(out.from, '2026-10-24T12:00:00.000Z');
  assert.equal(out.to, '2026-10-31T12:00:00.000Z');
  assert.equal(out.totalHours, 2.3);
  assert.deepEqual(out.byCategory, { music: 0.3, code: 1.5, browser: 0.5, other: 0.1 });
  assert.deepEqual(out.topApps, [
    { app: 'Cursor', hours: 1.5, category: 'code' },
    { app: 'Google Chrome', hours: 0.5, category: 'browser' },
    { app: 'Reason', hours: 0.3, category: 'music' },
    { app: 'Notion', hours: 0.1, category: 'other' }
  ]);

  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.method, 'POST');
  const body = JSON.parse(calls[1].init.body);
  const aql = body.query.join(' ');
  assert.match(aql, /filter_period_intersect/);
  assert.match(aql, /"aw-watcher-window_local"/);
  assert.match(aql, /"aw-watcher-afk_local"/);
  assert.doesNotMatch(aql, /other-host/);
  assert.deepEqual(body.timeperiods, ['2026-10-24T12:00:00.000Z/2026-10-31T12:00:00.000Z']);
  assert.ok(body.query.every(line => line.endsWith(';')), 'every AQL line ends with a semicolon');

  /* only app names leave: the fixture window titles are real text and must not survive */
  assert.doesNotMatch(JSON.stringify(out), /secret-project-file/);
});

test('hoursByApp keeps at most eight apps and skips zero or broken durations', async () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ duration: 600 - i * 10, data: { app: `App ${i}` } }));
  events.push({ duration: 0, data: { app: 'Idle' } }, { duration: 'nope', data: { app: 'Broken' } }, { duration: 60, data: {} });
  const out = await hoursByApp({ now: NOW, fetch: fakeFetch({ events }) });

  assert.equal(out.ok, true);
  assert.equal(out.topApps.length, 8);
  assert.equal(out.topApps[0].app, 'App 0');
  assert.equal(out.totalHours, 1.5);
  assert.deepEqual(out.byCategory, { music: 0, code: 0, browser: 0, other: 1.5 });
});

test('hoursByApp reports a connection error instead of throwing', async () => {
  const out = await hoursByApp({ now: NOW, fetch: fakeFetch({ error: 'connect ECONNREFUSED 127.0.0.1:5600' }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /ECONNREFUSED/);
});

test('hoursByApp reports a non-200 buckets read', async () => {
  const out = await hoursByApp({ now: NOW, fetch: fakeFetch({ status: 503 }) });
  assert.deepEqual(out, { ok: false, reason: 'HTTP 503' });
});

test('hoursByApp reports no buckets and never queries', async () => {
  const calls = [];
  const out = await hoursByApp({ now: NOW, fetch: fakeFetch({ buckets: {}, calls }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /bucket/i);
  assert.equal(calls.length, 1);
});

test('hoursByApp refuses a base that is not this machine', async () => {
  const calls = [];
  const out = await hoursByApp({ now: NOW, base: 'http://example.com:5600', fetch: fakeFetch({ calls }) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /localhost/);
  assert.equal(calls.length, 0);
});

test('categoryOf reads app names case-insensitively', () => {
  assert.equal(categoryOf('Reason 13.5'), 'music');
  assert.equal(categoryOf('REASON'), 'music');
  assert.equal(categoryOf('Code.exe'), 'code');
  assert.equal(categoryOf('WezTerm'), 'code');
  assert.equal(categoryOf('WindowsTerminal.exe'), 'code');
  assert.equal(categoryOf('msedge.exe'), 'browser');
  assert.equal(categoryOf('Firefox'), 'browser');
  assert.equal(categoryOf('Notion'), 'other');
  assert.equal(categoryOf(null), 'other');
});
