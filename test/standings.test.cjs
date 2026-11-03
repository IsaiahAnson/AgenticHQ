'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/standings.cjs');

const AT1 = '2026-10-01T18:00:00.000Z', AT2 = '2026-10-02T18:00:00.000Z', AT3 = '2026-10-03T18:00:00.000Z';
const run = (store, cands, id, at, opts) => S.mergeRun(store, cands, { runId: id, at, opts });
const byTitle = (store, t) => Object.values(store.items).find(i => i.title === t);

test('exports and frozen defaults', () => {
  for (const k of ['DEFAULTS', 'STATUSES', 'normalizeText', 'tokens', 'similarity', 'itemId', 'emptyStore', 'findMatch',
    'effectiveScore', 'mergeRun', 'rank', 'setStatus', 'view', 'load', 'save']) assert.ok(k in S, k);
  assert.ok(Object.isFrozen(S.DEFAULTS));
  assert.deepEqual([...S.STATUSES], ['open', 'approved', 'done', 'trashed']);
  assert.equal(S.DEFAULTS.hysteresis, 6);
  assert.equal(S.DEFAULTS.incumbentTop, 10);
  assert.equal(S.DEFAULTS.tiers[0].tier, 'S');
  assert.equal(S.DEFAULTS.tiers[0].maxRank, 3);
});

test('normalizeText, tokens and stemming', () => {
  assert.equal(S.normalizeText('  Café — Déjà-Vu!! '), 'cafe deja vu');
  assert.deepEqual(S.tokens('The runners are running and tested the classes'), ['runner', 'runn', 'test', 'class']);
  assert.deepEqual(S.tokens('glass boss'), ['glass', 'boss']);
  assert.deepEqual(S.tokens('a an the of'), []);
  assert.deepEqual(S.tokens('cache cache CACHE'), ['cache']);
});

test('similarity is Jaccard over token sets', () => {
  assert.equal(S.similarity('', 'x'), 0);
  assert.equal(S.similarity('quote paths with spaces', 'Quote the paths with spaces'), 1);
  const v = S.similarity('restart hq server', 'restart hq window');
  assert.ok(Math.abs(v - 0.5) < 1e-9, String(v));
});

test('itemId is stable and board-prefixed', () => {
  const a = S.itemId('learned', 'quote paths'), b = S.itemId('learned', 'quote paths');
  assert.equal(a, b);
  assert.match(a, /^lea-[0-9a-f]{10}$/);
  assert.notEqual(a, S.itemId('learned', 'other'));
});

test('mergeRun requires runId and at', () => {
  assert.throws(() => S.mergeRun(S.emptyStore('x'), [{ title: 't', score: 1 }], { at: AT1 }), e => e.code === 'STANDINGS_BAD_RUN');
  assert.throws(() => S.mergeRun(S.emptyStore('x'), [{ title: 't', score: 1 }], { runId: 'r' }), e => e.code === 'STANDINGS_BAD_RUN');
});

test('first run creates ranked items with tiers and movement new', () => {
  const s0 = S.emptyStore('learned');
  const s1 = run(s0, [
    { title: 'Quote paths with spaces in run()', score: 70, ref: 'p1', evidence: 'run failed on C:\\Program Files', reason: 'blocks runs' },
    { title: 'Copilot rejects piped prompts', score: 90, evidence: [{ text: 'stdin ignored', source: 'log' }] },
    { title: '', score: 99 }, { title: 'no score' }
  ], 'r1', AT1);
  assert.equal(Object.keys(s0.items).length, 0, 'input not mutated');
  assert.equal(Object.keys(s1.items).length, 2);
  const a = byTitle(s1, 'Copilot rejects piped prompts'), b = byTitle(s1, 'Quote paths with spaces in run()');
  assert.equal(a.rank, 1); assert.equal(b.rank, 2);
  assert.equal(a.tier, 'S');
  assert.equal(a.movement, 'new'); assert.equal(a.delta, null);
  assert.equal(a.seenCount, 1); assert.equal(a.firstSeen, AT1);
  assert.equal(a.status, 'open');
  assert.deepEqual(b.refs, ['p1']);
  assert.equal(b.evidence[0].text, 'run failed on C:\\Program Files');
  assert.equal(b.evidence[0].run, 'r1');
  assert.equal(a.evidence[0].source, 'log');
  assert.equal(s1.lastRunId, 'r1'); assert.equal(s1.updatedAt, AT1);
  assert.deepEqual(s1.runs, [{ id: 'r1', at: AT1, candidates: 2, added: 2, merged: 0 }]);
  assert.equal(a.score, 90);
});

test('empty or invalid run is a no-op (no decay, no log)', () => {
  const s1 = run(S.emptyStore('radar'), [{ title: 'A tool', score: 50 }], 'r1', AT1);
  const s2 = run(s1, [{ title: '   ', score: 5 }, { title: 'x', score: NaN }], 'r2', AT2);
  assert.deepEqual(s2, s1);
  assert.notEqual(s2, s1);
});

test('second run merges a near-duplicate, blends score, records alias and recurrence', () => {
  const s1 = run(S.emptyStore('learned'), [{ title: 'Quote paths with spaces in run calls', score: 60 }], 'r1', AT1);
  const s2 = run(s1, [{ title: 'Quote the paths with spaces in run call', score: 80, reason: 'new reason' }], 'r2', AT2);
  const items = Object.values(s2.items);
  assert.equal(items.length, 1);
  const i = items[0];
  assert.equal(i.seenCount, 2);
  assert.equal(i.baseScore, 72);                 // 0.6*80 + 0.4*60
  assert.equal(i.score, 76);                      // +4 recurrence (log2 2)
  assert.equal(i.reason, 'new reason');
  assert.deepEqual(i.aliases, ['Quote the paths with spaces in run call']);
  assert.equal(i.title, 'Quote paths with spaces in run calls');
  assert.equal(i.lastSeen, AT2); assert.equal(i.firstSeen, AT1);
  assert.equal(i.movement, 'same'); assert.equal(i.delta, 0);
  assert.deepEqual(s2.runs.map(r => [r.id, r.added, r.merged]), [['r1', 1, 0], ['r2', 0, 1]]);
});

test('same item twice in one run counts once and keeps the higher raw score', () => {
  const s1 = run(S.emptyStore('learned'), [{ title: 'Alpha beta gamma', score: 50 }], 'r1', AT1);
  const s2 = run(s1, [{ title: 'Alpha beta gamma', score: 60 }, { title: 'alpha beta gamma!', score: 90 }], 'r2', AT2);
  const i = Object.values(s2.items)[0];
  assert.equal(i.seenCount, 2);
  assert.equal(i.baseScore, 74);                  // 0.6*90 + 0.4*50
  assert.equal(i.scoreHistory.length, 2);
  assert.equal(i.scoreHistory[1].score, 90);
  assert.ok(!('_preRunBase' in i));
});

test('ref and mergeInto matching win over titles', () => {
  const s1 = run(S.emptyStore('radar'), [{ title: 'Tool X launches', score: 40, ref: 'https://x.dev' }], 'r1', AT1);
  const id = Object.keys(s1.items)[0];
  const s2 = run(s1, [{ title: 'Completely different words here', score: 40, ref: 'https://x.dev' }], 'r2', AT2);
  assert.equal(Object.keys(s2.items).length, 1);
  const s3 = run(s2, [{ title: 'Yet another unrelated headline', score: 40, mergeInto: id }], 'r3', AT3);
  assert.equal(Object.keys(s3.items).length, 1);
  assert.equal(s3.items[id].seenCount, 3);
  assert.equal(S.findMatch(s3, { title: 'nothing alike at all' }), null);
});

test('hysteresis: an incumbent keeps #1 unless clearly outscored', () => {
  const s1 = run(S.emptyStore('radar'), [{ title: 'Incumbent pick', score: 80 }, { title: 'Filler one', score: 10 }], 'r1', AT1);
  const keep = run(s1, [{ title: 'Incumbent pick', score: 80 }, { title: 'Shiny challenger', score: 84 }], 'r2', AT2);
  // incumbent baseScore stays 80, recurrence +4 => 84; sort key 90 vs challenger 84
  assert.equal(byTitle(keep, 'Incumbent pick').rank, 1);
  const lose = run(s1, [{ title: 'Shiny challenger', score: 87 }], 'r2', AT2);
  // incumbent missed one run: 80 - 1.5 = 78.5, key 84.5 < 87
  assert.equal(byTitle(lose, 'Shiny challenger').rank, 1);
  assert.equal(byTitle(lose, 'Shiny challenger').movement, 'new');
  assert.equal(byTitle(lose, 'Incumbent pick').rank, 2);
  assert.equal(byTitle(lose, 'Incumbent pick').movement, 'down');
  assert.equal(byTitle(lose, 'Incumbent pick').delta, -1);
  const hold = run(s1, [{ title: 'Shiny challenger', score: 84 }], 'r2', AT2);
  assert.equal(byTitle(hold, 'Incumbent pick').rank, 1, 'missed once still holds against 84');
});

test('decay is floored and never deletes an item', () => {
  let s = run(S.emptyStore('demo'), [{ title: 'Old winner', score: 50 }], 'r0', AT1);
  for (let k = 1; k <= 40; k++) s = run(s, [{ title: 'Other thing ' + 'x'.repeat(k), score: 1 }], 'r' + k, AT2);
  const w = byTitle(s, 'Old winner');
  assert.equal(w.missedRuns, 40);
  assert.equal(w.score, 30);                      // floor = 60% of 50
  assert.equal(S.effectiveScore({ baseScore: 50, seenCount: 1, missedRuns: 2 }), 47);
  assert.equal(S.effectiveScore({ baseScore: 99, seenCount: 1024, missedRuns: 0 }), 100);
});

test('status persists across runs; trashed items stay unranked when they return', () => {
  const s1 = run(S.emptyStore('learned'), [{ title: 'Bad idea', score: 95 }, { title: 'Good idea', score: 60 }], 'r1', AT1);
  const id = byTitle(s1, 'Bad idea').id;
  const s2 = S.setStatus(s1, id, 'trashed', { at: AT1, note: 'not useful' });
  assert.equal(s2.items[id].rank, null); assert.equal(s2.items[id].tier, null);
  assert.equal(byTitle(s2, 'Good idea').rank, 1);
  const s3 = run(s2, [{ title: 'Bad idea', score: 99 }], 'r2', AT2);
  assert.equal(s3.items[id].status, 'trashed');
  assert.equal(s3.items[id].note, 'not useful');
  assert.equal(s3.items[id].seenCount, 2);
  assert.equal(s3.items[id].rank, null);
  assert.throws(() => S.setStatus(s3, 'nope', 'done'), e => e.code === 'STANDINGS_UNKNOWN_ID');
  assert.throws(() => S.setStatus(s3, id, 'archived'), e => e.code === 'STANDINGS_BAD_STATUS');
  const s4 = S.setStatus(s3, id, 'open', { at: AT3 });
  assert.equal(s4.items[id].rank, 1);
  assert.equal(s4.items[id].movement, 'returned');
});

test('rank is idempotent and does not move prevRank', () => {
  const s1 = run(S.emptyStore('radar'), [{ title: 'one thing', score: 10 }, { title: 'two thing more', score: 20 }], 'r1', AT1);
  const s2 = run(s1, [{ title: 'one thing', score: 99 }], 'r2', AT2);
  const r1 = S.rank(s2), r2 = S.rank(r1);
  assert.deepEqual(r1, r2);
  assert.equal(byTitle(r2, 'one thing').movement, 'up');
  assert.equal(byTitle(r2, 'one thing').delta, 1);
  assert.equal(byTitle(r2, 'one thing').bestRank, 1);
});

test('tiers follow rank buckets; custom opts respected', () => {
  const cands = Array.from({ length: 12 }, (_, k) => ({ title: 'item number ' + String.fromCharCode(97 + k) + ' unique' + k, score: 100 - k }));
  const s = run(S.emptyStore('learned'), cands, 'r1', AT1);
  const tiers = Object.values(s.items).sort((a, b) => a.rank - b.rank).map(i => i.tier);
  assert.deepEqual(tiers, ['S', 'S', 'S', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'B', 'B']);
  const s2 = run(S.emptyStore('demo'), cands.slice(0, 3), 'r1', AT1, { tiers: [{ tier: 'TOP', maxRank: 1 }, { tier: 'REST', maxRank: Infinity }] });
  assert.deepEqual(Object.values(s2.items).sort((a, b) => a.rank - b.rank).map(i => i.tier), ['TOP', 'REST', 'REST']);
  const s3 = S.setStatus(s2, Object.values(s2.items)[0].id, 'approved', { opts: { rankedStatuses: ['open', 'approved'] } });
  assert.equal(Object.values(s3.items).filter(i => i.rank !== null).length, 3);
});

test('view: counts, tiers, filters, order and paging', () => {
  let s = run(S.emptyStore('learned'), [
    { title: 'Copilot needs plain prompts', score: 80, category: 'copilot' },
    { title: 'Quote run arguments', score: 70, summary: 'Windows shell splits paths' },
    { title: 'Restart guard trips after three restarts', score: 60 }
  ], 'r1', AT1);
  const done = byTitle(s, 'Restart guard trips after three restarts').id;
  s = S.setStatus(s, done, 'done', { at: AT2 });
  const v = S.view(s);
  assert.deepEqual(v.counts, { open: 2, approved: 0, done: 1, trashed: 0, total: 3 });
  assert.deepEqual(v.items.map(i => i.rank), [1, 2, null]);
  assert.equal(v.total, 3);
  assert.equal(v.tiers.length, S.DEFAULTS.tiers.length);
  assert.deepEqual(v.tiers[0], { tier: 'S', count: 2 });
  assert.ok(!('runIds' in v.items[0]) && !('scoreHistory' in v.items[0]));
  assert.deepEqual(S.view(s, { query: 'windows SHELL' }).items.map(i => i.title), ['Quote run arguments']);
  assert.deepEqual(S.view(s, { query: 'copilot' }).items.map(i => i.title), ['Copilot needs plain prompts']);
  assert.deepEqual(S.view(s, { status: 'done' }).items.map(i => i.id), [done]);
  assert.equal(S.view(s, { status: 'ranked' }).total, 2);
  assert.equal(S.view(s, { limit: 1, offset: 1 }).items[0].title, 'Quote run arguments');
  assert.equal(S.view(s, { query: 'copilot' }).counts.total, 3);
  assert.equal(v.runs[0].id, 'r1');
});

test('evidence dedupes, caps and keeps newest last', () => {
  let s = run(S.emptyStore('radar'), [{ title: 'Evidence item here', score: 50, evidence: ['A', 'a!', 'B'] }], 'r1', AT1);
  assert.deepEqual(Object.values(s.items)[0].evidence.map(e => e.text), ['A', 'B']);
  for (let k = 2; k <= 22; k++) s = run(s, [{ title: 'Evidence item here', score: 50, evidence: { text: 'E' + k, source: 's' } }], 'r' + k, AT2);
  const ev = Object.values(s.items)[0].evidence;
  assert.equal(ev.length, 12);
  assert.equal(ev[ev.length - 1].text, 'E22');
  assert.equal(Object.values(s.items)[0].runIds.length, 20);           // 22 runs, capped at maxHistory
  assert.equal(Object.values(s.items)[0].runIds[0], 'r3');
  assert.equal(Object.values(s.items)[0].seenCount, 22);
});

test('load and save protect history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standings-'));
  const f = path.join(dir, 'sub', 'board.json');
  assert.deepEqual(S.load(f, 'learned'), S.emptyStore('learned'));
  const s1 = run(S.emptyStore('learned'), [{ title: 'one item', score: 5 }, { title: 'two items again', score: 6 }], 'r1', AT1);
  S.save(f, s1);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['board.json']);
  assert.deepEqual(S.load(f, 'learned'), s1);
  assert.throws(() => S.save(f, S.emptyStore('learned')), e => e.code === 'STANDINGS_SHRINK');
  assert.equal(Object.keys(S.load(f, 'learned').items).length, 2);
  fs.writeFileSync(f, '{not json');
  assert.throws(() => S.load(f, 'learned'), e => e.code === 'STANDINGS_CORRUPT');
  fs.writeFileSync(f, '{"board":"x"}');
  assert.throws(() => S.load(f, 'learned'), e => e.code === 'STANDINGS_CORRUPT');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('matchByCategory keeps the same title in different categories apart', () => {
  const o = { matchByCategory: true };
  const both = [{ title: 'Use absolute paths in specs', category: 'worker-router', score: 60 },
    { title: 'Use absolute paths in specs', category: 'agenticos', score: 50 }];
  let s = run(S.emptyStore('learned'), both, 'r1', AT1, o);
  assert.equal(Object.keys(s.items).length, 2);
  s = run(s, [{ title: 'use absolute paths in the specs', category: 'agenticos', score: 70 }], 'r2', AT2, o);
  const items = Object.values(s.items);
  assert.equal(items.length, 2);
  assert.equal(items.find(i => i.category === 'agenticos').seenCount, 2);
  assert.equal(items.find(i => i.category === 'worker-router').seenCount, 1);
  assert.equal(Object.keys(run(S.emptyStore('learned'), both, 'r1', AT1).items).length, 1);   // default merges them
});

test('recurrencePerDoubling 0 turns the recurrence bonus off', () => {
  const item = { baseScore: 50, seenCount: 8, missedRuns: 0 };
  assert.equal(S.effectiveScore(item), 62);                                   // 50 + min(12, 4*log2(8))
  assert.equal(S.effectiveScore(item, { recurrencePerDoubling: 0 }), 50);
});
