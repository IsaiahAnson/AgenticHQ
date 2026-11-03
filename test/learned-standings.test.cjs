'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const S = require('../lib/standings.cjs');
const G = require('../lib/gotcha-proposals.cjs');
const A = require('../lib/gotcha-assess.cjs');
const L = require('../lib/learned.cjs');

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-board-')), skillsRoot = path.join(root, 'skills'), lessonsDir = path.join(root, 'lessons'), dataDir = path.join(root, 'data');
  fs.mkdirSync(skillsRoot); fs.mkdirSync(lessonsDir); fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(dataDir);
  const skillDir = path.join(skillsRoot, 'demo'); fs.mkdirSync(skillDir); fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Demo\n');
  fs.writeFileSync(path.join(root, 'config', 'lesson-skill-map.json'), JSON.stringify({ old: ['demo'] })); fs.writeFileSync(path.join(root, 'registry.md'), '');
  return { root, skillsRoot, lessonsDir, dataDir, standingsFile: path.join(dataDir, 'standings', 'learned.json'), dataFile: path.join(dataDir, 'gotcha-proposals.json') };
}
function lesson(n, date = '2020-01-01') { return `- **Run node tool-${n} --safe before changing path C:\\\\tmp** proof (verified ${date}) [ref: r${n}]`; }
function store(items, at = '2026-11-01T00:00:00Z') { return S.mergeRun(S.emptyStore('learned'), items, { runId: at, at, opts: G.LEARNED_OPTS }); }

test('all old lesson candidates enter the store without a cap', () => {
  const r = rig(); fs.writeFileSync(path.join(r.lessonsDir, 'old.md'), Array.from({ length: 12 }, (_, i) => lesson(i)).join('\n'));
  const out = G.buildProposals({ ...r, registryFile: path.join(r.root, 'registry.md'), dryRun: true, now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(out.candidateCount, 12); assert.equal(Object.keys(out.store.items).length, 12); assert.equal(out.proposals.length, 12);
});
test('missing next run item persists and increments missedRuns', () => {
  const s1 = store([{ key: 'a', title: 'Alpha exact command', category: 'demo', score: 50 }, { key: 'b', title: 'Beta exact flag', category: 'demo', score: 49 }]);
  const s2 = S.mergeRun(s1, [{ key: 'c', title: 'Gamma new challenger', category: 'demo', score: 52 }], { runId: 'r2', at: '2026-11-02T00:00:00Z', opts: G.LEARNED_OPTS });
  assert.equal(Object.values(s2.items).find(i => i.key === 'a').missedRuns, 1); assert.equal(Object.values(s2.items).find(i => i.key === 'a').rank, 1);
});
test('legacy migration is idempotent', () => {
  let s = store([{ key: 'a', title: 'Alpha', category: 'demo', score: 20 }, { key: 'b', title: 'Beta', category: 'demo', score: 21 }]);
  const state = { proposals: [{ id: 'a', status: 'applied', appliedAt: '2026-10-01T00:00:00Z' }, { id: 'b', status: 'rejected', rejectedAt: '2026-10-02T00:00:00Z' }] };
  const once = G.migrateStatuses(s, state), twice = G.migrateStatuses(once, state); assert.deepEqual(twice, once); assert.deepEqual(Object.values(once.items).map(i => i.status).sort(), ['done', 'trashed']);
});
test('heuristic is deterministic and capped at 55', () => { const p = { recurrence: 100000, sourceAt: '2026-11-01T00:00:00Z', text: '- Run node C:\\x --force.' }; assert.equal(G.heuristicScore(p, new Date('2026-11-01T00:00:00Z')), 55); assert.equal(G.heuristicScore(p, new Date('2026-11-01T00:00:00Z')), 55); });
test('registry accepts proposed watching and superseded but not terminal statuses', () => {
  const r = rig(), head = '| Fingerprint | Symptom | Verified cause | Workaround or fix | Scope | First seen | Last seen | Count | Status | Evidence |\n|---|---|---|---|---|---|---|---:|---|---|\n';
  fs.writeFileSync(path.join(r.root, 'registry.md'), head + ['proposed', 'watching', 'superseded', 'fixed', 'resolved', 'retired', 'dismissed'].map((x, i) => `| \`f${i}\` | s | c | f | HQ | a | b | 1 | ${x} | e |`).join('\n'));
  assert.deepEqual(G.parseRegistry(path.join(r.root, 'registry.md')).map(x => x.status), ['proposed', 'watching', 'superseded']);
});
test('rubric math reaches full 0-100 scale', () => { assert.equal(A.rubricScore({ pain: 10, frequency: 10, specificity: 10, fit: 10, durability: 10 }), 100); assert.equal(A.rubricScore({ pain: 5, frequency: 5, specificity: 5, fit: 5, durability: 5 }), 50); });
test('validator reports unknown id missing score and long reason together', () => {
  const s = store([{ title: 'Known item', score: 20 }]), result = A.validateBatch(s, { by: 'judge', assessments: [{ id: 'unknown', scores: { pain: 1 }, reason: 'word '.repeat(21), why: 'x', timeSaved: 'rare', effort: 'approve', timeReason: 'x', effortReason: 'x', evidenceChecked: [] }] });
  assert.ok(result.problems.some(x => /unknown/.test(x))); assert.ok(result.problems.some(x => /frequency/.test(x))); assert.ok(result.problems.some(x => /20 words/.test(x)));
});
test('validator demands critique for resulting top ten', () => {
  const s = store([{ title: 'Known item', score: 20 }]), id = Object.keys(s.items)[0], a = { id, scores: { pain: 1, frequency: 1, specificity: 1, fit: 1, durability: 1 }, reason: 'low', why: 'x', timeSaved: 'rare', effort: 'approve', timeReason: 'x', effortReason: 'x', evidenceChecked: [] };
  assert.ok(A.validateBatch(s, { by: 'judge', assessments: [a] }).problems.some(x => /critique/.test(x)));
});
test('judged score replaces base and movement remains against previous run', () => {
  let s = store([{ title: 'One item', score: 40 }, { title: 'Two item', score: 50 }]), id = Object.values(s.items).find(i => i.title === 'One item').id;
  s = S.mergeRun(s, [{ title: 'One item', score: 40 }, { title: 'Two item', score: 50 }], { runId: 'r2', at: '2026-11-02T00:00:00Z' });
  const other = Object.keys(s.items).find(x => x !== id);
  const input = { by: 'judge', assessments: [
    { id, scores: { pain: 10, frequency: 10, specificity: 10, fit: 10, durability: 10 }, reason: 'strong', why: 'x', timeSaved: 'daily', effort: 'approve', timeReason: 'x', effortReason: 'x', critique: 'Survives.', evidenceChecked: [] },
    { id: other, scores: { pain: 1, frequency: 1, specificity: 1, fit: 1, durability: 1 }, reason: 'weak', why: 'x', timeSaved: 'rare', effort: 'approve', timeReason: 'x', effortReason: 'x', critique: 'Too weak.', evidenceChecked: [] }
  ] };
  const out = A.applyJudgments(s, input, { now: new Date('2026-11-03T00:00:00Z') }); assert.equal(out.problems.length, 0); assert.equal(out.store.items[id].baseScore, 100); assert.equal(out.store.items[id].movement, 'up');
});
test('packet includes current-run candidates incumbents and bounded extras', () => {
  let s = store(Array.from({ length: 15 }, (_, i) => ({ key: `k${i}`, title: `Item unique ${i}`, category: 'demo', score: 80 - i })));
  const p = A.packet(s, { batch: 2 }); assert.equal(p.items.length, 12, 'incumbents and a bounded number of fresh candidates are included'); assert.ok(p.items[0].skillPath === undefined);
});
test('apply and dismiss helpers synchronize standings', () => {
  const r = rig(), file = path.join(r.skillsRoot, 'demo', 'SKILL.md'), proposal = { id: 'p1', skill: 'demo', file, section: 'Gotchas', text: '- Use exact node command.', status: 'proposed' };
  fs.writeFileSync(r.dataFile, JSON.stringify({ proposals: [proposal] })); let s = store([{ key: 'p1', title: 'Use exact node command.', category: 'demo', score: 20, data: { proposalId: 'p1' } }]); S.save(r.standingsFile, s);
  G.dismissProposals({ ids: ['p1'], dataFile: r.dataFile, standingsFile: r.standingsFile }); assert.equal(Object.values(S.load(r.standingsFile, 'learned').items)[0].status, 'trashed');
  const state = JSON.parse(fs.readFileSync(r.dataFile)); state.proposals[0].status = 'proposed'; fs.writeFileSync(r.dataFile, JSON.stringify(state)); s = S.setStatus(S.load(r.standingsFile, 'learned'), Object.keys(s.items)[0], 'open', { opts: G.LEARNED_OPTS }); S.save(r.standingsFile, s);
  G.applyProposals({ ids: ['p1'], dataFile: r.dataFile, standingsFile: r.standingsFile, skillsRoot: r.skillsRoot, commit: false }); assert.equal(Object.values(S.load(r.standingsFile, 'learned').items)[0].status, 'done');
});
test('status route applies dismisses and reopens while files agree', async () => {
  const r = rig(), file = path.join(r.skillsRoot, 'demo', 'SKILL.md'), proposal = { id: 'p1', skill: 'demo', file, section: 'Gotchas', text: '- Use exact node command.', status: 'proposed' };
  fs.writeFileSync(r.dataFile, JSON.stringify({ proposals: [proposal] })); const s = store([{ key: 'p1', title: 'Use exact node command.', category: 'demo', score: 20, data: { proposalId: 'p1', skill: 'demo', file, text: proposal.text } }]); S.save(r.standingsFile, s); const id = Object.keys(s.items)[0];
  const api = L.forServer({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, skillsRoot: r.skillsRoot, now: () => new Date('2026-11-01T00:00:00Z') });
  assert.equal((await api.handle('POST', '/status', null, { id, status: 'trashed' })).item.status, 'trashed'); assert.equal((await api.handle('POST', '/status', null, { id, status: 'open' })).item.status, 'open'); assert.equal((await api.handle('POST', '/status', null, { id, status: 'done' })).item.status, 'done'); assert.match(fs.readFileSync(file, 'utf8'), /Use exact node command/);
});
test('trashed item stays trashed through another merge run', () => { let s = store([{ key: 'p', title: 'Persistent item', category: 'demo', score: 50 }]), id = Object.keys(s.items)[0]; s = S.setStatus(s, id, 'trashed', { opts: G.LEARNED_OPTS }); s = S.mergeRun(s, [{ key: 'p', title: 'Persistent item', category: 'demo', score: 55 }], { runId: 'r2', at: '2026-11-02T00:00:00Z', opts: G.LEARNED_OPTS }); assert.equal(s.items[id].status, 'trashed'); });
test('collect returns ranked top ten and open total', () => { const r = rig(); const s = store(Array.from({ length: 12 }, (_, i) => ({ title: `Item ${i} unique`, score: i, category: 'demo', data: { skill: 'demo', text: `- Item ${i}` } }))); S.save(r.standingsFile, s); const out = L.collect({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, now: Date.parse('2026-11-01T00:00:00Z') }); assert.equal(out.pending.length, 10); assert.equal(out.openTotal, 12); assert.equal(out.pending[0].rank, 1); assert.ok(out.pending[0].tier); });
