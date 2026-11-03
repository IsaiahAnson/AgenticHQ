'use strict';
// Lead's tests for the engine's explicit-key identity, refs arrays and rerank (added with the Learned board).
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const S = require(path.join(process.env.HQ_REPO || path.join(__dirname, '..'), 'lib', 'standings.cjs'));

const AT1 = '2026-10-01T12:00:00.000Z', AT2 = '2026-10-08T12:00:00.000Z', AT3 = '2026-10-15T12:00:00.000Z', AT4 = '2026-10-22T12:00:00.000Z';
const run = (store, cands, id, at, opts) => S.mergeRun(store, cands, { runId: id, at, opts });
const items = store => Object.values(store.items);

test('an explicit key is the identity: the same key merges even when the title changes', () => {
  const s1 = run(S.emptyStore('radar'), [{ key: 'gh:acme/tool', title: 'Acme Tool 1.0 released', score: 50 }], 'r1', AT1);
  const s2 = run(s1, [{ key: 'gh:acme/tool', title: 'Completely different wording', score: 70 }], 'r2', AT2);
  assert.equal(items(s2).length, 1);
  const item = items(s2)[0];
  assert.equal(item.key, 'gh:acme/tool');
  assert.equal(item.seenCount, 2);
  assert.deepEqual(item.runIds, ['r1', 'r2']);
});

test('different keys never fuzzy-merge, even with identical titles', () => {
  const s1 = run(S.emptyStore('demo'), [{ key: 'drop-nightly', title: 'Retire the nightly export', score: 60 }], 'r1', AT1);
  const s2 = run(s1, [{ key: 'pause-nightly', title: 'Retire the nightly export', score: 60 }], 'r2', AT2);
  assert.equal(items(s2).length, 2);
});

test('title-only candidates keep ref and fuzzy matching; a keyed candidate skips both', () => {
  const s1 = run(S.emptyStore('learned'), [{ title: 'Quote paths with spaces in run()', score: 40, ref: 'lessons/a.md' }], 'r1', AT1);
  const s2 = run(s1, [{ title: 'Quote the paths with spaces in run()', score: 40 }], 'r2', AT2);
  assert.equal(items(s2).length, 1, 'title-only near-duplicate merges');
  const s3 = run(s2, [{ title: 'Totally unrelated headline here', score: 40, ref: 'lessons/a.md' }], 'r3', AT3);
  assert.equal(items(s3).length, 1, 'title-only ref match merges');
  const s4 = run(s3, [{ key: 'k-1', title: 'Quote paths with spaces in run()', score: 40, ref: 'lessons/a.md' }], 'r4', AT4);
  assert.equal(items(s4).length, 2, 'keyed candidate neither ref- nor fuzzy-merges');
});

test('mergeInto still wins over an explicit key', () => {
  const s1 = run(S.emptyStore('learned'), [{ key: 'a', title: 'Alpha lesson', score: 40 }], 'r1', AT1);
  const id = items(s1)[0].id;
  const s2 = run(s1, [{ key: 'b', title: 'Beta lesson', score: 40, mergeInto: id }], 'r2', AT2);
  assert.equal(items(s2).length, 1);
  assert.equal(s2.items[id].seenCount, 2);
});

test('an explicit key matches across categories, even with matchByCategory on', () => {
  const opts = { matchByCategory: true };
  const s1 = run(S.emptyStore('radar'), [{ key: 'gh:acme/tool', title: 'Acme Tool', category: 'tool', score: 40 }], 'r1', AT1, opts);
  const s2 = run(s1, [{ key: 'gh:acme/tool', title: 'Acme Tool 2.0', category: 'release', score: 45 }], 'r2', AT2, opts);
  assert.equal(items(s2).length, 1, 'a kind change does not create a twin');
  assert.equal(items(s2)[0].seenCount, 2);
  const s3 = run(s2, [{ title: 'Acme Tool', category: 'other', score: 30 }], 'r3', AT3, opts);
  assert.equal(items(s3).length, 2, 'title-only candidates still match within their category only');
});

test('refs arrays are stored, deduped and capped at the newest 20', () => {
  const refs = Array.from({ length: 25 }, (_, i) => 'src/' + i);
  const s1 = run(S.emptyStore('learned'), [{ key: 'r', title: 'Refs', score: 30, refs: [...refs.slice(0, 3), 'src/0', ''], ref: 'src/1' }], 'r1', AT1);
  assert.deepEqual(items(s1)[0].refs, ['src/0', 'src/1', 'src/2']);
  const got = items(run(s1, [{ key: 'r', title: 'Refs', score: 30, refs }], 'r2', AT2))[0].refs;
  assert.equal(got.length, 20);
  assert.equal(new Set(got).size, 20);
  assert.equal(got[got.length - 1], 'src/24', 'newest refs kept');
});

test('rerank replaces judged scores and re-ranks without counting a sighting', () => {
  const s1 = run(S.emptyStore('learned'), [{ key: 'a', title: 'Alpha lesson', score: 30 }, { key: 'b', title: 'Beta lesson', score: 50 }], 'r1', AT1);
  const a = items(s1).find(i => i.key === 'a');
  const s2 = S.rerank(s1, [{ id: a.id, score: 90, scores: { fit: 9 }, reason: 'judged', data: { judgment: { score: 90 } } }, { id: 'missing', score: 1 }]);
  const a2 = s2.items[a.id];
  assert.equal(a2.baseScore, 90);
  assert.equal(a2.reason, 'judged');
  assert.deepEqual(a2.scores, { fit: 9 });
  assert.equal(a2.data.judgment.score, 90);
  assert.equal(a2.seenCount, 1, 'no new sighting');
  assert.deepEqual(a2.runIds, ['r1']);
  assert.equal(s2.runs.length, 1, 'no new run');
  assert.equal(a2.rank, 1, 'a clearly better judged score overtakes');
  assert.equal(s1.items[a.id].baseScore, 30, 'input store untouched');
});
