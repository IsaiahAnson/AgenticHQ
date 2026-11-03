'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const standings = require('../lib/standings.cjs');
const { createRadar } = require('../lib/ai-radar.cjs');

let radar;
test.before(async () => { radar = await import('../tools/ai-radar.mjs'); });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'radar-standing-'));
const finding = (key, score, runId, extra = {}) => ({
  id: key.replace(/\W/g, '-'), key, title: extra.title || key, url: `https://example.com/${key}`,
  kind: 'tool', sources: [{ id: 'test', url: 'https://example.com' }], signals: extra.signals || { releaseTag: 'v1.0.0' },
  score: { total: score, parts: {} }, verdict: 'watch', confidence: 'medium', flags: [], summary: 'summary',
  whatsNew: extra.whatsNew || 'new signal', reasoning: extra.reasoning || 'Useful for durable workflows.', plan: [], reasonedBy: 'test', runId
});
const run = (id, rows, at = '2026-10-01T12:00:00.000Z') => ({ runId: id, startedAt: at, finishedAt: at, findings: rows });

test('fingerprint suppresses an unchanged triaged item', () => {
  const item = finding('gh:a/a', 50, 'r');
  const seen = radar.updateTriageSeen({}, [{ ...item, signals: { releaseTag: 'v1.0.0' } }], '2026-10-01');
  assert.equal(radar.shouldSuppress(item, seen[item.key]), true);
});

test('fingerprint re-triages changed signal', () => {
  const item = finding('gh:a/a', 50, 'r', { signals: { releaseTag: 'v2.0.0' } });
  assert.equal(radar.shouldSuppress(item, { fingerprint: 'v1.0.0' }), false);
});

test('dismissed item stays suppressed within a major version', () => {
  const item = finding('gh:a/a', 50, 'r', { signals: { releaseTag: 'v1.9.0' } });
  assert.equal(radar.shouldSuppress(item, null, { decision: 'dismiss', version: 'v1.2.0' }), true);
});

test('dismissed item returns on a new major version', () => {
  const item = finding('gh:a/a', 50, 'r', { signals: { releaseTag: 'v2.0.0' } });
  assert.equal(radar.shouldSuppress(item, null, { decision: 'dismiss', version: 'v1.2.0' }), false);
});

test('critique validation accepts bounded strict rows', () => {
  assert.deepEqual(radar.validateCritique([{ key: 'a', delta: -15, verdict: 'demote', critique: 'Risk.', reason: 'Too risky.' }], ['a'])[0].delta, -15);
});

test('critique validation rejects an out-of-bounds delta', () => {
  assert.throws(() => radar.validateCritique([{ key: 'a', delta: 6, verdict: 'keep', critique: 'No.', reason: 'No.' }], ['a']), /bounds/);
});

test('deadline allows critique only with six minutes remaining', () => {
  assert.equal(radar.critiqueTimeout(360000, 0), 300000);
  assert.equal(radar.critiqueTimeout(359999, 0), 0);
});

test('critique failure preserves scores', async () => {
  const rows = [finding('gh:a/a', 70, 'r')];
  const board = standings.emptyStore('radar');
  const result = await radar.critiqueFindings({ findings: rows, board, deadline: 500000, now: () => 0,
    cfg: {}, ctx: { usageGate: async () => 0, lanes: { claude: async () => 'not json' } } });
  assert.equal(result.ok, false);
  assert.equal(rows[0].score.total, 70);
});

test('backfill unions runs and is idempotent', () => {
  const dir = temp(); fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', 'a.json'), JSON.stringify(run('a', [finding('gh:a/a', 50, 'a')])));
  fs.writeFileSync(path.join(dir, 'runs', 'b.json'), JSON.stringify(run('b', [finding('gh:b/b', 60, 'b')], '2026-10-02T12:00:00.000Z')));
  const first = radar.backfillStandings(dir, { print: () => {} });
  const second = radar.backfillStandings(dir, { print: () => {} });
  assert.equal(first.uniqueKeys, 2);
  assert.equal(second.store.runs.length, 2);
});

test('backfill dry-run writes nothing', () => {
  const dir = temp(); fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', 'a.json'), JSON.stringify(run('a', [finding('gh:a/a', 50, 'a')])));
  radar.backfillStandings(dir, { dryRun: true, print: () => {} });
  assert.equal(fs.existsSync(path.join(dir, 'standings.json')), false);
});

test('missing entries persist and a clearly better item overtakes', () => {
  let store = standings.emptyStore('radar');
  store = radar.mergeFindings(store, run('a', [finding('gh:a/a', 50, 'a', { title: 'Alpha tool' })]));
  store = radar.mergeFindings(store, run('b', [finding('gh:b/b', 90, 'b', { title: 'Beta tool' })], '2026-10-02T12:00:00.000Z'));
  const list = standings.view(store, { status: 'ranked' }).items;
  assert.equal(list[0].title, 'Beta tool');
  assert.equal(list.find(x => x.title === 'Alpha tool').missedRuns, 1);
});

test('hysteresis keeps a close incumbent', () => {
  let store = standings.emptyStore('radar');
  store = radar.mergeFindings(store, run('a', [finding('gh:a/a', 84, 'a', { title: 'Incumbent' })]));
  store = radar.mergeFindings(store, run('b', [finding('gh:b/b', 86, 'b', { title: 'Challenger' })], '2026-10-02T12:00:00.000Z'));
  assert.equal(standings.view(store, { status: 'ranked' }).items[0].title, 'Incumbent');
  assert.equal(standings.rerank(store, [], { opts: { hysteresis: 0 } }).items[Object.values(store.items).find(x => x.title === 'Challenger').id].rank, 1);
});

test('scan reconciliation maps decisions into standings statuses', () => {
  let store = standings.emptyStore('radar');
  store = radar.mergeFindings(store, run('a', [finding('gh:a/a', 50, 'a', { title: 'Alpha' })]));
  const item = Object.values(store.items)[0];
  store = radar.reconcileDecisionStatuses(store, { items: { [item.data.id]: { decision: 'implement' } } }, '2026-10-02T12:00:00.000Z');
  assert.equal(store.items[item.id].status, 'approved');
  store = radar.reconcileDecisionStatuses(store, { items: { [item.data.id]: { decision: 'dismiss', version: 'v1.0.0' } } }, '2026-10-03T12:00:00.000Z');
  assert.equal(store.items[item.id].status, 'trashed');
});

test('standings API filters latest run and status route syncs decisions', async () => {
  const kit = temp(), dir = path.join(kit, 'data', 'radar'); fs.mkdirSync(dir, { recursive: true });
  let store = standings.emptyStore('radar');
  store = radar.mergeFindings(store, run('20261001-1200', [finding('gh:a/a', 50, '20261001-1200', { title: 'Alpha' })]));
  store = radar.mergeFindings(store, run('20261002-1200', [finding('gh:b/b', 80, '20261002-1200', { title: 'Beta' })], '2026-10-02T12:00:00.000Z'));
  standings.save(path.join(dir, 'standings.json'), store);
  const api = createRadar({ kit, dir, now: () => Date.parse('2026-10-03T12:00:00Z'), startJob: () => ({}) });
  const view = await api.handle('GET', '/standings', new URLSearchParams('run=latest&status=all'), null);
  assert.equal(view.items.length, 1); assert.equal(view.items[0].title, 'Beta');
  await api.handle('POST', '/status', null, { id: view.items[0].id, status: 'trashed', note: 'no' });
  const after = await api.handle('GET', '/standings', new URLSearchParams('status=trashed'), null);
  assert.equal(after.items[0].status, 'trashed');
  const decisions = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json')));
  assert.equal(decisions.items[view.items[0].data.id].decision, 'dismiss');
});
