'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const S = require('../lib/standings.cjs');
const G = require('../lib/gotcha-proposals.cjs');
const A = require('../lib/gotcha-assess.cjs');
const L = require('../lib/learned.cjs');
const { duplicateReport } = require('../lib/ranked-dupes.cjs');

const SKILLS = ['demo', 'other'];
function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, 'skills'), lessonsDir = path.join(root, 'lessons'), dataDir = path.join(root, 'data');
  for (const skill of SKILLS) {
    fs.mkdirSync(path.join(skillsRoot, skill), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, skill, 'SKILL.md'), '# Skill\n');
  }
  fs.mkdirSync(lessonsDir); fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(root, 'config', 'lesson-skill-map.json'), JSON.stringify({ topic: SKILLS }));
  fs.writeFileSync(path.join(root, 'registry.md'), '');
  return { root, skillsRoot, lessonsDir, dataDir, registryFile: path.join(root, 'registry.md'),
    dataFile: path.join(dataDir, 'gotcha-proposals.json'), standingsFile: path.join(dataDir, 'standings', 'learned.json'),
    skillFile: name => path.join(skillsRoot, name, 'SKILL.md') };
}
const at = new Date('2026-11-01T12:00:00Z'), later = new Date('2026-11-02T12:00:00Z');
const lesson = text => `- **${text}** (verified 2026-10-01) [ref: one]`;
const run = (r, now = at) => G.buildProposals({ ...r, now });
const state = r => JSON.parse(fs.readFileSync(r.dataFile, 'utf8'));
const proposal = (r, id) => state(r).proposals.find(p => p.id === id);
const store = r => S.load(r.standingsFile, 'learned');
const api = r => L.forServer({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, skillsRoot: r.skillsRoot });
const byTitle = (r, text) => Object.values(store(r).items).find(i => i.title.startsWith(text));
const cli = (r, ...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'learned-dedupe.mjs'), '--data-dir', r.dataDir, ...args], { encoding: 'utf8' });
/* The board as older runs left it: one item per skill and lesson, keyed by its proposal id. */
function legacy(r, rows) {
  let s = S.mergeRun(S.emptyStore('learned'), rows.map(row => ({ key: row.id, title: row.text, score: row.score || 40, category: row.skill,
    data: { proposalId: row.id, skill: row.skill, file: r.skillFile(row.skill), text: `- ${row.text}.`, recurrence: 1 } })), { runId: at.toISOString(), at: at.toISOString(), opts: G.LEARNED_OPTS });
  const ids = Object.fromEntries(Object.values(s.items).map(i => [i.key, i.id]));
  for (const row of rows) if (row.item) s = S.setStatus(s, ids[row.id], row.item, { at: at.toISOString(), opts: G.LEARNED_OPTS });
  S.save(r.standingsFile, s);
  fs.writeFileSync(r.dataFile, JSON.stringify({ version: 1, proposals: rows.map(row => ({ id: row.id, skill: row.skill, file: r.skillFile(row.skill), text: `- ${row.text}.`, status: row.status })) }, null, 2));
  return ids;
}
function judged(id, overrides = {}) {
  return { id, scores: { pain: 5, frequency: 5, specificity: 5, fit: 5, durability: 5 }, reason: 'Important fix', why: 'Prevents errors',
    timeSaved: 'rare', effort: 'approve', timeReason: 'Rare', effortReason: 'Approval', critique: 'Still relevant', evidenceChecked: [], ...overrides };
}

test('a lesson filed for several skills is one entry listing them all, run after run', t => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), [lesson('Use node --safe'), lesson('Check the lock before a write')].join('\n'));
  run(r); const second = run(r, later);
  assert.equal(state(r).proposals.length, 4, 'proposals stay one per skill and lesson');
  assert.equal(second.lessonCount, 2);
  const items = Object.values(store(r).items);
  assert.equal(items.length, 2);
  for (const item of items) {
    assert.deepEqual([...item.data.skills].sort(), SKILLS);
    assert.deepEqual(item.data.targets.map(x => x.status), ['proposed', 'proposed']);
    assert.equal(item.category, item.data.skills.join(', '));
    assert.equal(item.seenCount, 2, 'one sighting per run, not one per skill');
  }
  const pending = L.collect({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, now: +later }).pending;
  assert.equal(pending.length, 2);
  for (const p of pending) { assert.deepEqual([...p.skills].sort(), SKILLS); assert.equal(p.ids.length, 2); }
  assert.equal(duplicateReport(pending, { textOf: p => p.text }).duplicateTexts, 0);
});

test('a run folds the copies older runs left on the board and keeps each skill status', t => {
  const r = rig(t);
  const ids = legacy(r, [
    { id: 'p-demo', skill: 'demo', text: 'Use node --safe', status: 'applied', item: 'done' },
    { id: 'p-other', skill: 'other', text: 'Use node --safe', status: 'proposed' }
  ]);
  fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), lesson('Use node --safe'));
  run(r);
  const items = Object.values(store(r).items).filter(i => i.title === 'Use node --safe');
  assert.equal(items.length, 1, 'the run heals the board');
  const statuses = Object.fromEntries(items[0].data.targets.map(x => [x.skill, x.status]));
  assert.equal(statuses.demo, 'applied', 'the applied skill stays applied');
  assert.equal(items[0].status, 'open', 'it stays open while another skill waits');
  assert.equal(S.resolveId(store(r), ids['p-demo']), items[0].id);
  assert.equal(S.resolveId(store(r), ids['p-other']), items[0].id);
});

test('the dedupe tool folds copies, rejects a waiting same-skill copy, and writes only with --write', t => {
  const r = rig(t);
  const ids = legacy(r, [
    { id: 'p-demo', skill: 'demo', text: 'Use node --safe', status: 'applied', item: 'done' },
    { id: 'p-other', skill: 'other', text: 'Use node --safe', status: 'proposed' },
    { id: 'p-again', skill: 'demo', text: 'use NODE --safe!', status: 'proposed' },
    { id: 'q-demo', skill: 'demo', text: 'Check the lock before a write', status: 'proposed' }
  ]);
  const files = () => [fs.readFileSync(r.standingsFile, 'utf8'), fs.readFileSync(r.dataFile, 'utf8')];
  const untouched = files();
  const dry = cli(r, '--json');
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.deepEqual([plan.before.items, plan.after.items, plan.before.extraCopies, plan.after.extraCopies, plan.written], [4, 2, 2, 0, false]);
  assert.deepEqual(files(), untouched, 'a dry run writes nothing');
  const wrote = cli(r, '--write', '--json');
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(JSON.parse(wrote.stdout).written, true);
  const s = store(r), items = Object.values(s.items);
  assert.equal(items.length, 2);
  const kept = items.find(i => i.title !== 'Check the lock before a write');
  assert.deepEqual(Object.fromEntries(kept.data.targets.map(x => [x.skill, [x.proposalId, x.status]])), { demo: ['p-demo', 'applied'], other: ['p-other', 'proposed'] });
  assert.equal(kept.status, 'open');
  assert.deepEqual(kept.data.mergedProposalIds, ['p-again']);
  for (const id of ['p-demo', 'p-other', 'p-again']) assert.equal(S.resolveId(s, ids[id]), kept.id);
  assert.equal(proposal(r, 'p-again').status, 'rejected');
  assert.equal(proposal(r, 'p-again').rejectedReason, 'merged into p-demo');
  assert.equal(proposal(r, 'p-demo').status, 'applied');
  assert.equal(proposal(r, 'p-other').status, 'proposed');
  const again = JSON.parse(cli(r, '--write', '--json').stdout);
  assert.deepEqual([again.folds.length, again.written], [0, false], 'a second pass finds nothing');
});

test('--merge folds a reworded pair it names and refuses unknown ids', t => {
  const r = rig(t);
  legacy(r, [
    { id: 'h1', skill: 'demo', text: 'Health summaries: use only GET /api/health and report counts', status: 'proposed' },
    { id: 'h2', skill: 'demo', text: 'Use the fixed status-summary workflow: GET /api/health, then summarize', status: 'proposed' }
  ]);
  assert.equal(JSON.parse(cli(r, '--json').stdout).folds.length, 0, 'too different to fold on its own');
  const bad = cli(r, '--merge', 'h1=nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown Learned item or proposal: nope/);
  const out = cli(r, '--merge', 'h1=h2', '--write', '--json');
  assert.equal(out.status, 0, out.stderr);
  const items = Object.values(store(r).items);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /^Health summaries/);
  assert.equal(items[0].aliases.length, 1);
  assert.equal(proposal(r, 'h2').rejectedReason, 'merged into h1');
});

test('--merge can fold away an automatic fold survivor and each fold reports where it ended up', t => {
  const r = rig(t);
  legacy(r, [
    { id: 'c-demo', skill: 'demo', text: 'Use node --safe for every script run', status: 'proposed' },
    { id: 'c-other', skill: 'other', text: 'Use node --safe for every script run', status: 'proposed' },
    { id: 'h1', skill: 'demo', text: 'Run scripts with node --safe on this PC', status: 'proposed' }
  ]);
  const out = cli(r, '--merge', 'h1=c-other', '--write', '--json');
  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout), items = Object.values(store(r).items);
  assert.equal(items.length, 1);
  assert.equal(result.folds.length, 2);
  assert.ok(result.folds.every(f => f.keep === items[0].id), 'every fold names the item it ended up in');
  assert.deepEqual([...items[0].data.skills].sort(), SKILLS);
});

test('reworded copies fold when nearly identical, not when the meaning or a number changes', () => {
  assert.ok(G.sameLesson('- Always run the full test suite before you commit changes to main.', 'Always run the full test suite before you commit change to main'));
  assert.ok(G.sameLesson('Use node --safe', '- use NODE --safe.'));
  assert.ok(!G.sameLesson('Use node --safe', 'Use node safely'), 'short texts fold only when the same');
  assert.ok(!G.sameLesson('Run the cleanup audit as a read only pass first and write recommendations to the report file',
    'Do not run the cleanup audit as a read only pass first and write recommendations to the report file'));
  assert.ok(!G.sameLesson('Wait 30 seconds before you retry the worker dispatch call', 'Wait 60 seconds before you retry the worker dispatch call'));
});

test('a decided entry reopens only when a skill comes back, is added, or he reopens it', () => {
  let s = S.mergeRun(S.emptyStore('learned'), [{ key: 'a', title: 'Use node --safe', score: 40,
    data: { proposalId: 'a', targets: [{ skill: 'demo', proposalId: 'a', status: 'applied' }, { skill: 'other', proposalId: 'b', status: 'proposed' }] } }], { runId: 'r1', at: at.toISOString(), opts: G.LEARNED_OPTS });
  const id = Object.keys(s.items)[0];
  s = S.setStatus(s, id, 'done', { at: at.toISOString(), opts: G.LEARNED_OPTS });
  const proposals = { proposals: [{ id: 'a', status: 'applied' }, { id: 'b', status: 'proposed' }] };
  assert.equal(G.syncTargets(s, proposals).items[id].status, 'done', 'a store-only decision is not undone');
  assert.equal(G.syncTargets(s, proposals, { reopen: true }).items[id].status, 'open');
  assert.equal(G.syncTargets(s, proposals, { reopen: new Set([id]), notes: new Map([[id, { open: 'new for other' }]]) }).items[id].note, 'new for other');
  const open = S.setStatus(s, id, 'open', { opts: G.LEARNED_OPTS });
  assert.equal(G.syncTargets(open, { proposals: [{ id: 'a', status: 'applied' }, { id: 'b', status: 'rejected' }] }).items[id].status, 'done', 'deciding the last skill always lands');
});

test('the status route applies, dismisses and reopens every skill of one entry, or the ones named', async t => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), [lesson('Check the lock before a write'), lesson('Pin the exact model id in every card'), lesson('Use node --safe')].join('\n'));
  run(r);
  const lock = byTitle(r, 'Check the lock'), pin = byTitle(r, 'Pin the exact'), safe = byTitle(r, 'Use node');
  const done = await api(r).handle('POST', '/status', null, { id: lock.id, status: 'done' });
  assert.deepEqual(done.applied.map(a => a.skill).sort(), SKILLS);
  assert.equal(done.item.status, 'done');
  for (const skill of SKILLS) assert.match(fs.readFileSync(r.skillFile(skill), 'utf8'), /Check the lock before a write/);
  await assert.rejects(api(r).handle('POST', '/status', null, { id: lock.id, status: 'done' }), e => e.status === 409);
  const trashed = await api(r).handle('POST', '/status', null, { id: pin.id, status: 'trashed' });
  assert.equal(trashed.dismissed.length, 2);
  assert.equal(trashed.item.status, 'trashed');
  const reopened = await api(r).handle('POST', '/status', null, { id: pin.id, status: 'open' });
  assert.equal(reopened.item.status, 'open');
  for (const t2 of store(r).items[pin.id].data.targets) assert.equal(proposal(r, t2.proposalId).reopenedBy, 'widget');
  const one = await api(r).handle('POST', '/status', null, { id: safe.id, status: 'done', skills: ['other'] });
  assert.deepEqual(one.applied.map(a => a.skill), ['other']);
  assert.equal(one.item.status, 'open', 'still waiting on demo');
  assert.doesNotMatch(fs.readFileSync(r.skillFile('demo'), 'utf8'), /Use node --safe/);
  const row = L.collect({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, now: +at }).pending.find(p => p.standingsId === safe.id);
  assert.deepEqual([row.skills, row.ids.length], [['demo'], 1]);
});

test('an id from a folded copy still answers on the status route', async t => {
  const r = rig(t);
  const ids = legacy(r, [
    { id: 'p-demo', skill: 'demo', text: 'Use node --safe', status: 'proposed' },
    { id: 'p-other', skill: 'other', text: 'Use node --safe', status: 'proposed' }
  ]);
  assert.equal(cli(r, '--write').status, 0);
  const keptId = S.resolveId(store(r), ids['p-other']), stale = keptId === ids['p-demo'] ? ids['p-other'] : ids['p-demo'];
  const out = await api(r).handle('POST', '/status', null, { id: stale, status: 'trashed' });
  assert.equal(out.item.id, keptId);
  assert.equal(out.item.status, 'trashed');
  assert.deepEqual([proposal(r, 'p-demo').status, proposal(r, 'p-other').status], ['rejected', 'rejected']);
});

test('a judge merge across skills makes one entry listing both; a same-skill merge rejects the waiting copy', t => {
  const r = rig(t);
  const ids = legacy(r, [
    { id: 'a1', skill: 'demo', text: 'Release finished workers with the reap tool and never close their terminals by hand', status: 'proposed', score: 30 },
    { id: 'b1', skill: 'other', text: 'Use the reap tool to release finished workers instead of closing their terminals', status: 'proposed', score: 60 },
    { id: 'c1', skill: 'demo', text: 'Pin the exact model id in every scheduled card', status: 'proposed', score: 20 },
    { id: 'd1', skill: 'demo', text: 'Every scheduled card names its exact model id', status: 'proposed', score: 50 }
  ]);
  const s = store(r);
  assert.ok(A.packet(s).items.find(i => i.id === ids.a1).possibleDuplicates.some(d => d.id === ids.b1), 'the judge sees the likely copy');
  const out = A.applyJudgments(s, { by: 'judge', assessments: [judged(ids.a1, { mergeInto: ids.b1 }), judged(ids.b1), judged(ids.c1, { mergeInto: ids.d1 }), judged(ids.d1)] }, { now: at, state: state(r) });
  assert.deepEqual(out.problems, []);
  assert.equal(Object.keys(out.store.items).length, 2);
  assert.deepEqual([...out.store.items[ids.b1].data.skills].sort(), SKILLS);
  assert.equal(out.state.proposals.find(p => p.id === 'a1').status, 'proposed', 'a different skill joins the entry and keeps waiting');
  assert.deepEqual(out.rejected, ['c1']);
  assert.equal(out.state.proposals.find(p => p.id === 'c1').rejectedReason, 'merged into d1');
  assert.equal(S.resolveId(out.store, ids.a1), ids.b1);
});
