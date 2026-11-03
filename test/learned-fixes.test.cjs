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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-fixes-'));
  const skillsRoot = path.join(root, 'skills'), lessonsDir = path.join(root, 'lessons');
  const dataDir = path.join(root, 'data'), skill = path.join(skillsRoot, 'demo', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.mkdirSync(lessonsDir); fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(dataDir);
  fs.writeFileSync(skill, '# Demo\n');
  fs.writeFileSync(path.join(root, 'config', 'lesson-skill-map.json'), JSON.stringify({ topic: ['demo'] }));
  fs.writeFileSync(path.join(root, 'registry.md'), '');
  return { root, skillsRoot, lessonsDir, dataDir, skill, registryFile: path.join(root, 'registry.md'),
    dataFile: path.join(dataDir, 'gotcha-proposals.json'), standingsFile: path.join(dataDir, 'standings', 'learned.json') };
}
const at = new Date('2026-11-01T12:00:00Z');
const lesson = (text, date = '2026-10-01', refs = '[ref: one]') => `- **${text}** (verified ${date}) ${refs}`;
function run(r, now = at) { return G.buildProposals({ ...r, now }); }
function state(r) { return JSON.parse(fs.readFileSync(r.dataFile, 'utf8')); }
function board(rows) {
  return S.mergeRun(S.emptyStore('learned'), rows, { runId: at.toISOString(), at: at.toISOString(), opts: G.LEARNED_OPTS });
}
function assessment(id, overrides = {}) {
  return { id, scores: { pain: 5, frequency: 5, specificity: 5, fit: 5, durability: 5 },
    reason: 'Important fix', why: 'Prevents errors', timeSaved: 'rare', effort: 'approve',
    timeReason: 'Rare occurrence', effortReason: 'Approval', critique: 'Still relevant',
    evidenceChecked: [], ...overrides };
}

test('pending IDs refer to proposals and expose separate standings IDs', () => {
  const r = rig(); fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), lesson('Use node --safe'));
  run(r);
  const pending = L.collect({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, now: +at }).pending;
  assert.ok(pending.length);
  for (const p of pending) {
    assert.ok(state(r).proposals.some(row => row.id === p.id));
    assert.ok(S.load(r.standingsFile, 'learned').items[p.standingsId]);
  }
});

test('superseded and edited proposals are retired without another sighting', () => {
  for (const replacement of ['- ~~**Use node --safe**~~', lesson('Use node --safer')]) {
    const r = rig(), file = path.join(r.lessonsDir, 'topic.md');
    fs.writeFileSync(file, lesson('Use node --safe')); const first = run(r);
    const old = Object.values(first.store.items)[0];
    fs.writeFileSync(file, replacement); const second = run(r, new Date(+at + 86400000));
    assert.equal(second.store.items[old.id].status, 'trashed');
    assert.equal(second.store.items[old.id].note, 'no longer in the lessons');
    assert.equal(second.store.items[old.id].missedRuns, 1);
    assert.equal(second.store.items[old.id].seenCount, 1);
    assert.equal(state(r).proposals.find(p => p.id === old.key).rejectedReason, 'superseded');
    if (replacement.includes('--safer')) assert.ok(Object.values(second.store.items).some(i => i.status === 'open' && i.title.includes('--safer')));
  }
});

test('an unsighted missing legacy row is added once and recorded as applied when already in skill', () => {
  const r = rig(), p = { id: 'legacy', skill: 'demo', file: r.skill, text: '- Always run node --safe before writing files.', status: 'proposed' };
  fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), '# Topic\n');
  fs.writeFileSync(r.skill, '# Demo\n\nAlways run node --safe before writing files.\n');
  fs.writeFileSync(r.dataFile, JSON.stringify({ proposals: [p] }));
  const result = run(r), item = Object.values(result.store.items)[0];
  assert.equal(item.status, 'done'); assert.equal(item.note, 'already in SKILL.md');
  assert.equal(item.missedRuns, 1); assert.equal(state(r).proposals[0].appliedReason, 'already in SKILL.md');
  assert.equal(Object.values(run(r, new Date(+at + 86400000)).store.items)[0].missedRuns, 2);
});

test('judged assessment and judgment survive sightings and changed recurrence enters the packet', () => {
  const r = rig(), file = path.join(r.lessonsDir, 'topic.md');
  fs.writeFileSync(file, lesson('Use node --safe')); let result = run(r);
  const id = Object.keys(result.store.items)[0];
  result = A.applyJudgments(result.store, { by: 'judge', assessments: [assessment(id)] }, { now: at });
  assert.deepEqual(result.problems, []);
  S.save(r.standingsFile, result.store);
  const proposals = state(r);
  proposals.proposals[0].assessment = { why: 'Outdated assessment' };
  fs.writeFileSync(r.dataFile, JSON.stringify(proposals));
  fs.writeFileSync(file, lesson('Use node --safe', '2026-10-01', '[ref: one] [ref: two]'));
  const next = run(r, new Date(+at + 86400000)), item = next.store.items[id];
  assert.equal(item.data.assessment.why, 'Prevents errors');
  assert.equal(item.data.judgment.recurrence, 1);
  assert.equal(item.data.recurrence, 2);
  assert.ok(A.packet(next.store).items.some(i => i.id === id));
});

test('packet bounds fresh items and documents allowed answers', () => {
  const s = board(Array.from({ length: 120 }, (_, i) => ({ key: String(i), title: `Lesson ${i}`, score: i % 100 })));
  const p = A.packet(s);
  assert.equal(p.items.length, 50);
  assert.deepEqual(p.answer.timeSaved, Object.keys(A.TIME_SAVED));
  assert.deepEqual(p.answer.effort, Object.keys(A.EFFORT));
  assert.deepEqual(p.answer.scores, Object.keys(A.CRITERIA));
  const errors = A.validateBatch(s, { by: 'judge', assessments: [assessment(p.items[0].id, { timeSaved: 'bad', effort: 'bad' })] }).problems.join(' ');
  assert.match(errors, /rare, monthly, weekly, daily/); assert.match(errors, /approve, small, medium, large/);
});

test('validator rejects self merges, cycles and a judged top-10 item without critique', () => {
  const s = board(Array.from({ length: 11 }, (_, i) => ({ key: String(i), title: `Lesson ${i}`, score: 100 - i * 5 })));
  const ordered = Object.values(s.items).sort((a, b) => a.rank - b.rank), [a, b] = ordered;
  assert.match(A.validateBatch(s, { by: 'judge', assessments: [assessment(a.id, { mergeInto: a.id })] }).problems.join(' '), /itself/);
  assert.match(A.validateBatch(s, { by: 'judge', assessments: [assessment(a.id, { mergeInto: b.id }), assessment(b.id, { mergeInto: a.id })] }).problems.join(' '), /chains and cycles/);
  const assessments = ordered.slice(0, 10).map(i => assessment(i.id, i === a ? { mergeInto: b.id } : {}));
  const merged = A.validateBatch(s, { by: 'judge', assessments });
  assert.deepEqual(merged.problems, [], 'an unjudged item that rises after a merge does not fail the batch');
  assert.deepEqual(merged.uncritiqued, [ordered[10].id], 'it is reported for the next packet instead');
  const silent = ordered.slice(0, 10).map(i => assessment(i.id, i === b ? { critique: '' } : {}));
  assert.ok(A.validateBatch(s, { by: 'judge', assessments: silent }).problems.some(p => p.startsWith(b.id) && p.includes('Lesson 1') && p.includes('critique')));
});

test('judge answers with non-text fields are problems, not crashes', () => {
  const s = board([{ key: 'p', title: 'Lesson', score: 10 }]), id = Object.keys(s.items)[0];
  const input = { by: 'judge', assessments: [assessment(id, { why: 5, reason: 7, timeReason: ['x'], critique: {} })] };
  const problems = A.validateBatch(s, input).problems.join(' | ');
  for (const field of ['why is required text', 'reason is required text', 'timeReason is required text', 'critique must be text']) assert.ok(problems.includes(field), field);
  assert.ok(A.applyJudgments(s, input, { now: at }).problems.length);
});

function snapshot(r) {
  const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), artifacts = path.join(r.root, 'artifacts');
  return { state: read(r.dataFile), standings: read(r.standingsFile), artifacts: fs.existsSync(artifacts) ? fs.readdirSync(artifacts).sort() : [] };
}

test('a bad source read aborts the run before anything is written', () => {
  const breaks = {
    'map missing': r => fs.rmSync(path.join(r.root, 'config', 'lesson-skill-map.json')),
    'map empty': r => fs.writeFileSync(path.join(r.root, 'config', 'lesson-skill-map.json'), '{}'),
    'mapped topic file missing': r => fs.writeFileSync(path.join(r.root, 'config', 'lesson-skill-map.json'), JSON.stringify({ topic: ['demo'], gone: ['demo'] })),
    'registry missing': r => fs.rmSync(r.registryFile),
    'registry unreadable': r => { fs.rmSync(r.registryFile); fs.mkdirSync(r.registryFile); },
    'proposals file corrupt': r => fs.writeFileSync(r.dataFile, '{ not json')
  };
  for (const [name, breakIt] of Object.entries(breaks)) {
    const r = rig(); fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), lesson('Use node --safe'));
    run(r);
    breakIt(r);
    const before = snapshot(r);
    assert.throws(() => run(r, new Date(+at + 86400000)), Error, name);
    assert.deepEqual(snapshot(r), before, `${name}: state, standings and reports are untouched`);
  }
});

test('an auto-retired proposal comes back when its lesson returns', () => {
  const r = rig(), file = path.join(r.lessonsDir, 'topic.md');
  fs.writeFileSync(file, lesson('Use node --safe')); const first = run(r), old = Object.values(first.store.items)[0];
  fs.writeFileSync(file, lesson('Use node --safer')); run(r, new Date(+at + 86400000));
  assert.equal(state(r).proposals.find(p => p.id === old.key).rejectedReason, 'superseded');
  fs.writeFileSync(file, lesson('Use node --safe')); const third = run(r, new Date(+at + 2 * 86400000));
  const proposal = state(r).proposals.find(p => p.id === old.key);
  assert.equal(proposal.status, 'proposed'); assert.ok(proposal.revivedAt); assert.equal(proposal.rejectedReason, undefined);
  assert.equal(third.store.items[old.id].status, 'open'); assert.equal(third.store.items[old.id].note, 'back in the lessons');
  const dismissed = state(r).proposals.find(p => p.text.includes('--safer'));
  assert.equal(dismissed.rejectedReason, 'superseded', 'the lesson that left is retired in turn');
});

test('a reopened item stays open on the next run after its lesson is gone', async () => {
  const r = rig(), file = path.join(r.lessonsDir, 'topic.md');
  fs.writeFileSync(file, lesson('Use node --safe')); const first = run(r), old = Object.values(first.store.items)[0];
  fs.writeFileSync(file, lesson('Use node --safer')); run(r, new Date(+at + 86400000));
  assert.equal(S.load(r.standingsFile, 'learned').items[old.id].status, 'trashed');
  const api = L.forServer({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, skillsRoot: r.skillsRoot, now: () => new Date(+at + 86400000 + 60000) });
  assert.equal((await api.handle('POST', '/status', null, { id: old.id, status: 'open' })).item.status, 'open');
  const next = run(r, new Date(+at + 2 * 86400000));
  assert.equal(next.store.items[old.id].status, 'open', 'the reopen persists');
  const proposal = state(r).proposals.find(p => p.id === old.key);
  assert.equal(proposal.status, 'proposed'); assert.equal(proposal.reopenedBy, 'widget');
});

test('a corrupt standings file falls back to pending proposals instead of breaking the widget', () => {
  const r = rig(); fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), lesson('Use node --safe'));
  run(r);
  fs.writeFileSync(r.standingsFile, '{ broken');
  const d = L.collect({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, now: +at });
  assert.equal(d.standingsError, 'STANDINGS_CORRUPT');
  assert.equal(d.pending.length, 1); assert.equal(d.openTotal, 1);
});

test('standings route ignores non-numeric limit and offset', async () => {
  const r = rig(); S.save(r.standingsFile, board(Array.from({ length: 3 }, (_, i) => ({ key: `p${i}`, title: `Lesson ${i}`, score: 10 + i }))));
  const api = L.forServer({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, skillsRoot: r.skillsRoot });
  const view = await api.handle('GET', '/standings', new URLSearchParams('limit=abc&offset=-5'));
  assert.equal(view.items.length, 3);
});

test('merged proposal records target proposal id', () => {
  const { spawnSync } = require('node:child_process');
  const r = rig();
  const s = board([{ key: 'proposal-a', title: 'First', score: 50 }, { key: 'proposal-b', title: 'Second', score: 40 }]);
  const [a, b] = Object.values(s.items);
  S.save(r.standingsFile, s);
  fs.writeFileSync(r.dataFile, JSON.stringify({ proposals: [{ id: a.key, status: 'proposed' }] }));
  const input = path.join(r.root, 'judgments.json');
  fs.writeFileSync(input, JSON.stringify({ by: 'judge', assessments: [assessment(a.id, { mergeInto: b.id })] }));
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'gotcha-assess.mjs'), '--file', input, '--data-dir', r.dataDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state(r).proposals[0].status, 'rejected');
  assert.equal(state(r).proposals[0].rejectedReason, 'merged into proposal-b');
});

test('status transitions reject prototype ids and invalid reopen requests', async () => {
  const r = rig(), s = board([{ key: 'p', title: 'One', score: 10, data: { proposalId: 'p', skill: 'demo', file: r.skill, text: '- One' } }]);
  const id = Object.keys(s.items)[0], api = L.forServer({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, skillsRoot: r.skillsRoot });
  for (const status of ['done', 'approved']) {
    S.save(r.standingsFile, S.setStatus(s, id, status, { opts: G.LEARNED_OPTS }));
    await assert.rejects(api.handle('POST', '/status', null, { id, status: 'open' }), e => e.status === 409);
  }
  await assert.rejects(api.handle('POST', '/status', null, { id: 'constructor', status: 'open' }), e => e.status === 404);
  await assert.rejects(api.handle('POST', '/status', null, { id, status: 'bogus' }), e => e.status === 400);
  await assert.rejects(api.handle('POST', '/status', null, null), e => e.status === 400);
  assert.throws(() => G.applyProposals({ ids: [], dataFile: r.dataFile }), e => e.status === 400);
  assert.throws(() => G.dismissProposals({ ids: ['missing'], dataFile: r.dataFile }), e => e.status === 404);
  fs.writeFileSync(r.dataFile, JSON.stringify({ proposals: [{ id: 'p', status: 'applied' }] }));
  assert.throws(() => G.dismissProposals({ ids: ['p'], dataFile: r.dataFile }), e => e.status === 409);
});

test('status response returns items beyond the default 500-row view', async () => {
  const r = rig(), rows = Array.from({ length: 600 }, (_, i) => ({ key: `p${i}`, title: `Lesson ${i}`, score: 10,
    data: { proposalId: `p${i}`, skill: 'demo', file: r.skill, text: `- Lesson ${i}` } }));
  const s = board(rows), item = Object.values(s.items).find(i => i.rank === 600);
  S.save(r.standingsFile, s);
  fs.writeFileSync(r.dataFile, JSON.stringify({ proposals: [{ id: item.key, status: 'proposed', skill: 'demo' }] }));
  const api = L.forServer({ kit: r.root, lessonsDir: r.lessonsDir, dataDir: r.dataDir, skillsRoot: r.skillsRoot });
  const result = await api.handle('POST', '/status', null, { id: item.id, status: 'trashed' });
  assert.equal(result.item.id, item.id); assert.equal(result.item.status, 'trashed');
});

test('lesson dates drive distinct heuristic scores', () => {
  const r = rig(); fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), [lesson('Use node --old', '2024-01-01'), lesson('Use node --new', '2026-10-01')].join('\n'));
  const items = run(r).proposals;
  assert.notEqual(G.heuristicScore(items[0], at), G.heuristicScore(items[1], at));
});

test('changed evidence outside the top ten is selected before unchanged judged items', () => {
  let s = board(Array.from({ length: 12 }, (_, i) => ({
    key: String(i), title: `Lesson ${i}`, score: 90 - i,
    data: { recurrence: 1, sourceAt: '2026-10-01', judgment: { recurrence: 1, sourceAt: '2026-10-01', judgedAt: at.toISOString() } }
  })));
  s = S.mergeRun(s, Object.values(s.items).map(i => ({
    key: i.key, title: i.title, score: i.score,
    data: { recurrence: i.rank === 12 ? 2 : 1 }
  })), { runId: 'next', at: new Date(+at + 86400000).toISOString(), opts: G.LEARNED_OPTS });
  const changed = Object.values(s.items).find(i => i.data.recurrence === 2);
  assert.ok(A.packet(s, { batch: 1 }).items.some(i => i.id === changed.id));
});

test('Learned controller searches, paginates, preserves state on refresh and reports action errors', async () => {
  const H = require('../assets/hq-standings.js'), requests = [], toasts = [], paints = [];
  const rows = Array.from({ length: 620 }, (_, i) => ({ id: String(i) }));
  const board = H.controller({
    api: async url => {
      const params = new URL(url, 'http://localhost').searchParams;
      requests.push(params);
      return { items: rows.slice(+params.get('offset'), +params.get('offset') + 500), total: rows.length };
    },
    post: async () => ({ error: 'Board is busy' }),
    toast: message => toasts.push(message),
    paint: view => paints.push(view)
  });
  await board.load({ status: 'done', query: 'safe path' });
  assert.equal(requests[0].get('status'), 'done');
  assert.equal(requests[0].get('q'), 'safe path');
  assert.equal(requests[0].get('limit'), '500');
  assert.equal(requests[0].get('offset'), '0');
  await board.load(board.state, true);
  assert.equal(requests[1].get('offset'), '500');
  assert.deepEqual(board.items, rows);
  const before = board.state;
  await board.act('0', 'open');
  assert.deepEqual(toasts, ['Board is busy']);
  assert.deepEqual(board.state, before);
  await board.refresh();
  assert.equal(requests[2].get('status'), 'done');
  assert.equal(requests[2].get('q'), 'safe path');
  assert.equal(requests[2].get('offset'), '0');
  assert.equal(requests[3].get('offset'), '500');
  assert.deepEqual(board.items, rows);
  assert.equal(board.status, 'done');
  assert.equal(board.query, 'safe path');
  assert.equal(paints.length, 3);
});

test('rubric bars render their values and use the CSS variable', () => {
  const H = require('../assets/hq-standings.js');
  const css = fs.readFileSync(path.join(__dirname, '..', 'assets', 'hq-standings.css'), 'utf8');
  const markup = H.detail({ data: { judgment: { scores: { pain: 1, frequency: 2, specificity: 3, fit: 4, durability: 5 } } } });
  const bars = [...markup.matchAll(/<div class="hs-score">[\s\S]*?<i style="--p:(\d+)%"><\/i>/g)];
  assert.deepEqual(bars.map(m => +m[1]), [10, 20, 30, 40, 50]);
  assert.match(css, /\.hs-score i\s*\{[^}]*var\(--p/);
});

test('ring report uses 12-hour display and retains its icon', () => {
  const r = rig(), s = board([{ key: 'p', title: 'Lesson', score: 10 }]);
  const report = G.writeReport({ artifactsDir: path.join(r.root, 'artifacts'), store: s, generatedAt: at.toISOString() });
  const html = fs.readFileSync(path.join(r.root, 'artifacts', report.htmlName), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(r.root, 'artifacts', report.jsonName), 'utf8'));
  assert.match(html, /Generated .* (?:AM|PM)/);
  assert.match(html, /<style>/);
  assert.match(meta.svg, /<path/);
});

test('a real run reports its top ten like a dry run', () => {
  const r = rig(); fs.writeFileSync(path.join(r.lessonsDir, 'topic.md'), [lesson('Use node --safe'), lesson('Quote paths with spaces')].join('\n'));
  const dry = G.buildProposals({ ...r, now: at, dryRun: true });
  const real = run(r);
  assert.ok(real.top.length > 0);
  assert.deepEqual(real.top.map(t => t.title), dry.top.map(t => t.title));
});

test('the retired --missing flag answers nothing missing instead of failing an old HQ prompt', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'gotcha-assess.mjs'), '--missing', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
  assert.match(r.stderr, /retired/);
});
