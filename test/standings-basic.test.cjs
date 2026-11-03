'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const s = require('../lib/standings.cjs');

const at = '2026-11-01T10:00:00.000Z';
const run = (store, candidates, runId = 'r1', opts = {}) =>
  s.mergeRun(store, candidates, { runId, at, opts });
const one = store => Object.values(store.items)[0];

test('normalizes, removes stopwords and applies one stemming rule', () => {
  assert.equal(s.normalizeText('Crème—BRÛLÉE!'), 'creme brulee');
  assert.deepEqual(s.tokens('The running runners boxes passed glass cats cats'),
    ['runn', 'runner', 'box', 'pass', 'glass', 'cat']);
});

test('similarity uses sets and handles empty terms', () => {
  assert.equal(s.similarity('the and', 'the'), 0);
  assert.equal(s.similarity('red red fox', 'red dog'), 1 / 3);
});

test('new run creates ranked items without changing the original', () => {
  const original = s.emptyStore('learned');
  const next = run(original, [{ title: ' Alpha ', score: 102 }, { title: 'Beta', score: -3 }]);
  assert.deepEqual(original, s.emptyStore('learned'));
  assert.equal(next.runs[0].added, 2);
  assert.equal(next.items[s.itemId('learned', 'alpha')].baseScore, 100);
  assert.equal(next.items[s.itemId('learned', 'beta')].baseScore, 0);
  assert.equal(one(next).movement, 'new');
});

test('near duplicates merge and record alias, evidence and occurrence', () => {
  let store = run(s.emptyStore('learned'), [{ title: 'Improve caching performance', score: 80, evidence: 'Proof' }]);
  store = run(store, [{ title: 'Improve caching performance today', score: 90, evidence: ['proof', { text: 'New', source: 'web' }] }], 'r2');
  const item = one(store);
  assert.equal(Object.keys(store.items).length, 1);
  assert.equal(item.seenCount, 2);
  assert.equal(item.baseScore, 86);
  assert.deepEqual(item.aliases, ['Improve caching performance today']);
  assert.deepEqual(item.evidence.map(e => e.text), ['Proof', 'New']);
});

test('empty or invalid run is a deep no-op', () => {
  const store = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 30 }]);
  const next = run(store, [{ title: '', score: 5 }, { title: 'x', score: NaN }], 'r2');
  assert.deepEqual(next, store);
  assert.notStrictEqual(next.items, store.items);
  assert.throws(() => s.mergeRun(store, [], {}), { code: 'STANDINGS_BAD_RUN' });
});

test('hysteresis keeps an incumbent against 84 but not 87', () => {
  const opts = { recurrencePerDoubling: 0, decayPerMissedRun: 0 };
  const first = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 80 }], 'r1', opts);
  const under = run(first, [{ title: 'Beta', score: 84 }], 'r2', opts);
  const over = run(first, [{ title: 'Beta', score: 87 }], 'r2', opts);
  assert.equal(under.items[s.itemId('learned', 'alpha')].rank, 1);
  assert.equal(over.items[s.itemId('learned', 'alpha')].rank, 2);
  assert.deepEqual(s.rank(under, opts), under);
});

test('decay stops at the configured floor and recurrence can be disabled', () => {
  assert.equal(s.effectiveScore({ baseScore: 80, seenCount: 20, missedRuns: 100 }, { recurrencePerDoubling: 0 }), 48);
  assert.equal(s.effectiveScore({ baseScore: 90, seenCount: 4, missedRuns: 0 }), 98);
});

test('trashed items stay trashed when matched again', () => {
  let store = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 50 }]);
  const id = one(store).id;
  store = s.setStatus(store, id, 'trashed', { at, note: 'irrelevant' });
  store = run(store, [{ title: 'Alpha', score: 70 }], 'r2');
  assert.equal(store.items[id].status, 'trashed');
  assert.equal(store.items[id].rank, null);
  assert.equal(store.items[id].seenCount, 2);
  assert.equal(store.items[id].note, 'irrelevant');
});

test('setStatus reports bad ids and statuses', () => {
  const store = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 50 }]);
  assert.throws(() => s.setStatus(store, 'missing', 'open'), { code: 'STANDINGS_UNKNOWN_ID' });
  assert.throws(() => s.setStatus(store, one(store).id, 'invalid'), { code: 'STANDINGS_BAD_STATUS' });
});

test('view filters, ordering, counts and pagination', () => {
  let store = run(s.emptyStore('learned'), [
    { title: 'Alpha', summary: 'quick win', score: 30 },
    { title: 'Beta', summary: 'quick fix', score: 80 },
    { title: 'Gamma', summary: 'quick fix', score: 70 }
  ]);
  const beta = s.itemId('learned', 'beta'), gamma = s.itemId('learned', 'gamma');
  store = s.setStatus(store, beta, 'done', { at: '2026-11-01T11:00:00Z' });
  store = s.setStatus(store, gamma, 'trashed', { at: '2026-11-01T12:00:00Z' });
  const result = s.view(store, { query: 'QUICK fix' });
  assert.deepEqual(result.counts, { open: 1, approved: 0, done: 1, trashed: 1, total: 3 });
  assert.deepEqual(result.items.map(item => item.id), [gamma, beta]);
  assert.equal(result.total, 2);
  assert.equal(s.view(store, { status: 'ranked', limit: 1 }).total, 1);
  assert.deepEqual(s.view(store, { status: 'done' }).items.map(item => item.id), [beta]);
  assert.equal(s.view(store, { offset: 1, limit: 1 }).items[0].id, gamma);
  assert.equal(result.tiers[0].count, 0);
  assert.equal('runIds' in result.items[0], false);
});

test('same run candidates use highest raw score and blend only once', () => {
  let store = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 50 }]);
  store = run(store, [{ title: 'Alpha', score: 60 }, { title: 'Alpha', score: 90 },
    { title: 'Alpha', score: 70 }], 'r2');
  assert.equal(one(store).seenCount, 2);
  assert.equal(one(store).baseScore, 74);
  assert.equal(one(store).scoreHistory.at(-1).score, 90);
  const fresh = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 10 }, { title: 'Alpha', score: 80 }]);
  assert.equal(one(fresh).baseScore, 80);
});

test('matching respects category except explicit refs and mergeInto', () => {
  const store = run(s.emptyStore('learned'), [
    { title: 'Alpha', category: 'one', score: 50, ref: 'ref1' },
    { title: 'Alpha', category: 'two', score: 60 }
  ], 'r1', { matchByCategory: true });
  assert.equal(Object.keys(store.items).length, 2);
  const first = Object.values(store.items).find(item => item.category === 'one');
  assert.equal(s.findMatch(store, { title: 'Other', category: 'two', ref: 'ref1' }, { matchByCategory: true }), first.id);
  assert.equal(s.findMatch(store, { title: 'Other', mergeInto: first.id }, { matchByCategory: true }), first.id);
});

test('load rejects corrupt files and supplies missing top-level fields', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.json');
  assert.deepEqual(s.load(file, 'learned'), s.emptyStore('learned'));
  fs.writeFileSync(file, '{');
  assert.throws(() => s.load(file, 'learned'), { code: 'STANDINGS_CORRUPT' });
  fs.writeFileSync(file, '{"items":[]}');
  assert.throws(() => s.load(file, 'learned'), { code: 'STANDINGS_CORRUPT' });
  fs.writeFileSync(file, '{"items":{}}');
  assert.deepEqual(s.load(file, 'learned'), s.emptyStore('learned'));
});

test('save prevents shrinking and atomically leaves no temporary file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'store.json');
  const store = run(s.emptyStore('learned'), [{ title: 'Alpha', score: 50 }]);
  s.save(file, store);
  const content = fs.readFileSync(file, 'utf8');
  assert.deepEqual(s.load(file, 'learned'), store);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['store.json']);
  assert.throws(() => s.save(file, s.emptyStore('learned')), { code: 'STANDINGS_SHRINK' });
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});
