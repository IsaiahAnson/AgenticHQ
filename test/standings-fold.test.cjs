'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const S = require('../lib/standings.cjs');

const AT = '2026-11-01T12:00:00.000Z', AT2 = '2026-11-02T12:00:00.000Z';
function board() {
  let s = S.mergeRun(S.emptyStore('learned'), [
    { key: 'a', title: 'Alpha lesson about locks', score: 30, refs: ['a.md:1'] },
    { key: 'b', title: 'Beta lesson about locks', score: 70, refs: ['b.md:2'], reason: 'stronger' },
    { key: 'c', title: 'Gamma unrelated lesson', score: 50 },
    { key: 'd', title: 'Delta unrelated lesson', score: 20 }
  ], { runId: 'r1', at: AT });
  s = S.mergeRun(s, [{ key: 'b', title: 'Beta lesson about locks', score: 70 }, { key: 'c', title: 'Gamma unrelated lesson', score: 50 }], { runId: 'r2', at: AT2 });
  const id = key => Object.values(s.items).find(i => i.key === key).id;
  return { s, a: id('a'), b: id('b'), c: id('c'), d: id('d') };
}

test('foldItems carries sightings, evidence, refs, aliases and the best rank into the kept item', () => {
  const { s, a, b } = board(), seen = [];
  const folded = S.foldItems(s, a, [b, a, 'missing'], { at: AT2, mergeItem(keep, drop) { seen.push([keep.key, drop.key]); } });
  const kept = folded.items[a];
  assert.deepEqual(seen, [['a', 'b']], 'mergeItem runs once per real drop; self and unknown ids are skipped');
  assert.ok(!Object.hasOwn(folded.items, b));
  assert.equal(folded.merges[b], a);
  assert.ok(Object.hasOwn(s.items, b), 'the input store is left as it was');
  assert.equal(kept.title, 'Alpha lesson about locks');
  assert.deepEqual(kept.aliases, ['Beta lesson about locks']);
  assert.deepEqual([...kept.refs].sort(), ['a.md:1', 'b.md:2']);
  assert.equal(kept.baseScore, 70, 'the higher base score wins');
  assert.equal(kept.reason, 'stronger');
  assert.equal(kept.seenCount, 2, 'a sighting in the same run counts once');
  assert.deepEqual(kept.runIds, ['r1', 'r2']);
  assert.equal(kept.firstSeen, AT);
  assert.equal(kept.lastSeen, AT2);
  assert.equal(kept.bestRank, Math.min(s.items[a].bestRank, s.items[b].bestRank));
  assert.deepEqual(kept.mergedFrom.map(m => ({ id: m.id, key: m.key, status: m.status, at: m.at })), [{ id: b, key: 'b', status: 'open', at: AT2 }]);
  assert.throws(() => S.foldItems(s, 'nope', [a]), { code: 'STANDINGS_UNKNOWN_ID' });
});

test('resolveId follows chained folds and answers null for unknown ids', () => {
  const { s, a, b, c } = board();
  const twice = S.foldItems(S.foldItems(s, a, [b]), c, [a]);
  assert.equal(twice.merges[b], c, 'an earlier fold is re-pointed at the new survivor');
  assert.equal(S.resolveId(twice, b), c);
  assert.equal(S.resolveId(twice, a), c);
  assert.equal(S.resolveId(twice, c), c);
  assert.equal(S.resolveId(twice, 'nope'), null);
});

test('save lets a fold shrink the store by the items it recorded, and no further', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standings-fold-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { s, a, b, c, d } = board(), file = path.join(dir, 'learned.json');
  S.save(file, s);
  const folded = S.foldItems(s, a, [b]);
  S.save(file, folded);
  assert.equal(Object.keys(S.load(file, 'learned').items).length, 3);
  const dropped = structuredClone(folded); delete dropped.items[d];
  assert.throws(() => S.save(file, dropped), { code: 'STANDINGS_SHRINK' }, 'an item removed without a merge is refused');
  const worse = S.foldItems(folded, a, [c]); delete worse.items[d];
  assert.throws(() => S.save(file, worse), { code: 'STANDINGS_SHRINK' }, 'a shrink beyond the recorded merges is refused');
  assert.equal(Object.keys(S.load(file, 'learned').items).length, 3);
});
