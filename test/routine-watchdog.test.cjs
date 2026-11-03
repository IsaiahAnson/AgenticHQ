'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { expectedFires, missedCron, windowsTaskResult } = require('../lib/routine-watchdog.cjs');

const TZ = 'America/New_York';
const ms = value => Date.parse(value);

test('daily expected fire', () => {
  const result = missedCron({ cron: '15 8 * * *', lastRunAt: '2026-10-27T12:15:00Z', now: ms('2026-10-28T18:00:00Z'), timeZone: TZ });
  assert.equal(result.missed, 1); assert.equal(new Date(result.lastExpected).toISOString(), '2026-10-28T12:15:00.000Z');
});

test('weekdays skip weekends', () => {
  const fires = expectedFires({ cron: '0 8 * * 1-5', from: ms('2026-10-23T13:00:00Z'), to: ms('2026-10-26T14:00:00Z'), timeZone: TZ });
  assert.deepEqual(fires.map(x => new Date(x).toISOString()), ['2026-10-26T12:00:00.000Z']);
});

test('multiple hours select 9 and 18', () => {
  const fires = expectedFires({ cron: '0 9,18 * * *', from: ms('2026-10-28T12:00:00Z'), to: ms('2026-10-29T00:00:00Z'), timeZone: TZ });
  assert.deepEqual(fires.map(x => new Date(x).toISOString()), ['2026-10-28T13:00:00.000Z', '2026-10-28T22:00:00.000Z']);
});

test('weekly Sunday task finds the prior Sunday', () => {
  const result = missedCron({ cron: '30 7 * * 0', lastRunAt: '2026-10-18T11:30:00Z', now: ms('2026-10-26T16:00:00Z'), timeZone: TZ });
  assert.equal(result.missed, 1); assert.equal(new Date(result.lastExpected).toISOString(), '2026-10-25T11:30:00.000Z');
});

test('never-run task uses createdAt for its count', () => {
  const result = missedCron({ cron: '0 9 * * *', createdAt: ms('2026-10-27T15:00:00Z'), lastRunAt: null, now: ms('2026-10-28T18:00:00Z'), timeZone: TZ });
  assert.equal(result.missed, 1);
});

test('Windows-style schedules do not count fires before their trigger starts', () => {
  const result = missedCron({ cron: '0 7 * * 2', createdAt: ms('2026-10-28T20:00:00Z'), now: ms('2026-10-28T21:00:00Z'), timeZone: TZ, respectCreatedAt: true });
  assert.equal(result.missed, 0); assert.equal(result.lastExpected, null);
});

test('re-enabled task ignores fires from while it was off', () => {
  const floor = ms('2026-10-28T17:36:00Z');
  const quiet = missedCron({ cron: '15 8 * * *', lastRunAt: '2026-10-23T23:21:56Z', createdAt: floor, now: ms('2026-10-28T21:40:00Z'), timeZone: TZ, respectCreatedAt: true });
  assert.equal(quiet.missed, 0);
  const nextDay = missedCron({ cron: '15 8 * * *', lastRunAt: '2026-10-23T23:21:56Z', createdAt: floor, now: ms('2026-10-29T16:00:00Z'), timeZone: TZ, respectCreatedAt: true });
  assert.equal(nextDay.missed, 1);
});

test('task created after today\'s fire is not missed', () => {
  const result = missedCron({ cron: '0 9 * * *', createdAt: ms('2026-10-28T15:12:04Z'), now: ms('2026-10-28T21:40:00Z'), timeZone: TZ, respectCreatedAt: true });
  assert.equal(result.missed, 0);
});

test('two-hour grace keeps a recent scheduled fire healthy', () => {
  const result = missedCron({ cron: '0 9 * * *', createdAt: ms('2026-10-28T12:00:00Z'), now: ms('2026-10-28T14:30:00Z'), timeZone: TZ });
  assert.equal(result.missed, 0);
});

test('a currently running Windows task keeps its last run and is not a failure', () => {
  assert.deepEqual(windowsTaskResult(267009), { never: false, running: true, failed: false });
  assert.deepEqual(windowsTaskResult(267011), { never: true, running: false, failed: false });
  assert.equal(windowsTaskResult(1).failed, true);
});

test('DST fall-back enumerates both 1:30 wall-clock fires', () => {
  const fires = expectedFires({ cron: '30 1 * * *', from: ms('2026-11-01T04:00:00Z'), to: ms('2026-11-01T08:00:00Z'), timeZone: TZ });
  assert.deepEqual(fires.map(x => new Date(x).toISOString()), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
});
