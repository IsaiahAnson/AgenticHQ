'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BACKOFF_MS, DAY_MS, HOUR_MS, companionDecision, observeCrash, observeHealthy, record, shouldRestart, takeFlappingEvent } = require('../lib/restart-guard.cjs');

const NOW = Date.parse('2026-10-29T12:00:00.000Z');
const MINUTE = 60 * 1000;

test('three restart attempts in 60 minutes block the fourth', () => {
  const history = [NOW - 59 * MINUTE, NOW - 30 * MINUTE, NOW - MINUTE];
  assert.deepEqual(shouldRestart(history, NOW), { allowed: false, recent: 3, history });
});

test('an attempt 61 minutes old no longer counts toward the limit', () => {
  const history = [NOW - 61 * MINUTE, NOW - 30 * MINUTE, NOW - MINUTE];
  assert.equal(shouldRestart(history, NOW).allowed, true);
  assert.equal(shouldRestart(history, NOW).recent, 2);
});

test('record prunes restart history older than 24 hours', () => {
  const history = [NOW - DAY_MS - MINUTE, NOW - DAY_MS, NOW - MINUTE];
  assert.deepEqual(record(history, NOW), [NOW - DAY_MS, NOW - MINUTE, NOW]);
});

test('companion crashes back off 1, 5, then 15 minutes with a fake clock', () => {
  let state = observeCrash({}, { id: 'one', at: NOW }, NOW);
  assert.equal(companionDecision(state, NOW).retryAt, NOW + BACKOFF_MS[0]);
  state = observeCrash(state, { id: 'two', at: NOW + 2 * MINUTE }, NOW + 2 * MINUTE);
  assert.equal(companionDecision(state, NOW + 2 * MINUTE).retryAt, NOW + 7 * MINUTE);
  state = observeCrash(state, { id: 'three', at: NOW + 8 * MINUTE }, NOW + 8 * MINUTE);
  assert.equal(state.backoffUntil, NOW + 23 * MINUTE);
  assert.equal(companionDecision(state, NOW + 8 * MINUTE).reason, 'flapping-hold');
});

test('three crashes emit flapping once and hold for an hour', () => {
  let state = {};
  for (let i = 0; i < 3; i++) state = observeCrash(state, { id: String(i), at: NOW + i * MINUTE }, NOW + i * MINUTE);
  const first = takeFlappingEvent(state, NOW + 2 * MINUTE);
  assert.equal(first.emit, true);
  assert.equal(takeFlappingEvent(first.state, NOW + 3 * MINUTE).emit, false);
  assert.equal(companionDecision(first.state, NOW + 59 * MINUTE).allowed, false);
});

test('a healthy probe releases the latch and one hour uptime resets backoff', () => {
  let state = {};
  for (let i = 0; i < 3; i++) state = observeCrash(state, { id: String(i), at: NOW + i * MINUTE }, NOW + i * MINUTE);
  state = observeHealthy(state, { now: NOW + 3 * MINUTE, startedAt: NOW + 2 * MINUTE });
  assert.equal(state.holdUntil, undefined);
  state = observeHealthy(state, { now: NOW + 2 * HOUR_MS, startedAt: NOW + HOUR_MS });
  assert.deepEqual(state.crashes, []);
  assert.equal(companionDecision(state, NOW + 2 * HOUR_MS).allowed, true);
});
