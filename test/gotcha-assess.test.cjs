'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const assess = require('../lib/gotcha-assess.cjs');

const good = { id: 'a', why: 'It prevents a repeated failure.', timeSaved: 'monthly', effort: 'small', timeReason: 'Twice monthly.', effortReason: 'One config edit.' };

test('assessment validation accepts known categories and rejects invalid fields', () => {
  assert.equal(assess.validateAssessment(good), true);
  assert.throws(() => assess.validateAssessment({ ...good, why: 'x'.repeat(201) }), /200 characters/);
  assert.throws(() => assess.validateAssessment({ ...good, timeSaved: 'sometimes' }), /timeSaved/);
  assert.throws(() => assess.validateAssessment({ ...good, effort: 'tiny' }), /effort/);
});

test('fallback maps recurrence to fixed time categories', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12].map(recurrence => assess.fallbackAssessment({ recurrence }).timeSaved),
    ['rare', 'monthly', 'monthly', 'weekly', 'weekly', 'daily']);
  assert.equal(assess.fallbackAssessment({ recurrence: 2 }).why, 'Agents hit this 2x; the rule stops it repeating.');
  assert.equal(assess.fallbackAssessment({}).by, 'auto');
});

test('apply merges assessments immutably and reports unknown ids', () => {
  const state = { version: 1, proposals: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
  const result = assess.applyAssessments(state, [good, { ...good, id: 'missing' }], { by: 'tester', now: '2026-10-29T12:00:00Z' });
  assert.deepEqual(result.applied, ['a']);
  assert.deepEqual(result.unknown, ['missing']);
  assert.equal(result.state.proposals.length, 2);
  assert.equal(result.state.proposals[0].assessment.by, 'tester');
  assert.equal(result.state.proposals[0].assessment.at, '2026-10-29T12:00:00.000Z');
  assert.equal(state.proposals[0].assessment, undefined);
});
