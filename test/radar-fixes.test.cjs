'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const standings = require('../lib/standings.cjs');
const { createRadar, majorOf } = require('../lib/ai-radar.cjs');

const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-fixes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const finding = (key = 'gh:a/a', score = 70) => ({
  id: 'gh-a-a', key, title: 'Alpha', kind: 'tool', url: 'https://example.com/a',
  signals: { releaseTag: 'v1.0.0' }, sources: [], score: { total: score },
  reasoning: { summary: 'Reasoning pass', effort: 'M', risks: [{ kind: 'privacy', detail: 'risk' }] },
  plan: [], verdict: 'watch', reasonedBy: 'test', pinned: 'v1.0.0'
});
const run = rows => ({ runId: '20261001-1200', startedAt: '2026-10-01T12:00:00Z', findings: rows });

test('major versions share the server rule and reject dates, SHAs and bare numbers', async () => {
  const { majorVersion, dismissedReturns } = await import('../tools/ai-radar.mjs');
  for (const [value, expected] of [['rust-v0.166.0', 0], ['v2.1.0', 2], ['2026-11-01', null], ['published 2026-11-01', null], ['a1234567', null], ['42', null]]) {
    assert.equal(majorOf(value), expected);
    assert.equal(majorVersion(value), expected);
  }
  assert.equal(dismissedReturns({ decision: 'dismiss', version: '2025-01-01' }, { signals: { version: '2026-01-01' } }), false);
});

test('article fingerprints use collected dates and suppress unchanged dates', async () => {
  const { updateTriageSeen, shouldSuppress } = await import('../tools/ai-radar.mjs');
  const original = { key: 'url:article', title: 'Article', date: '2026-10-01', signals: {} };
  const seen = updateTriageSeen({}, [original], '2026-10-02');
  assert.equal(seen[original.key].fingerprint, '2026-10-01');
  assert.equal(shouldSuppress({ ...original, signals: {} }, seen[original.key]), true);
  assert.equal(shouldSuppress({ ...original, date: '2026-10-03' }, seen[original.key]), false);
});

test('tier dismiss records the current version including after resurfacing', async t => {
  const radar = await import('../tools/ai-radar.mjs');
  const dir = temp(t), f = finding();
  standings.save(path.join(dir, 'standings.json'), radar.mergeFindings(standings.emptyStore('radar'), run([f])));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(run([f])));
  fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify({ [f.key]: { lastVersion: 'v1.0.0' } }));
  const api = createRadar({ dir, kit: dir }), id = Object.keys(standings.load(path.join(dir, 'standings.json'), 'radar').items)[0];
  await api.handle('POST', '/status', null, { id, status: 'trashed' });
  assert.equal(api.readDecisions().items[f.id].version, 'v1.0.0');
  fs.writeFileSync(path.join(dir, 'seen.json'), JSON.stringify({ [f.key]: { lastVersion: 'v2.0.0' } }));
  assert.equal(api.overview().decisions[f.id].resurfaced, true);
  await api.handle('POST', '/status', null, { id, status: 'trashed' });
  assert.equal(api.readDecisions().items[f.id].version, 'v2.0.0');
  assert.equal(api.overview().decisions[f.id].active, true);
  assert.equal((await api.handle('GET', '/standings', new URLSearchParams('status=trashed'))).items.length, 1);
});

test('status changes refuse active or merged builds and discard reopens the board', async t => {
  const radar = await import('../tools/ai-radar.mjs'), dir = temp(t), f = finding();
  const board = radar.mergeFindings(standings.emptyStore('radar'), run([f])), id = Object.keys(board.items)[0];
  standings.save(path.join(dir, 'standings.json'), board);
  const writeDecision = d => fs.writeFileSync(path.join(dir, 'decisions.json'), JSON.stringify({ items: { [f.id]: d }, log: [] }));
  const api = createRadar({ dir, kit: dir, worktreesRoot: path.join(dir, 'wt'), git: async () => ({ code: 1, stdout: '', stderr: '' }) });
  writeDecision({ decision: 'implement', key: f.key, jobStatus: 'running' });
  for (const status of ['open', 'done', 'trashed']) await assert.rejects(api.handle('POST', '/status', null, { id, status }), e => e.status === 409);
  writeDecision({ decision: 'implement', key: f.key, merged: { at: 'now' }, cleanedUp: 'now' });
  await assert.rejects(api.handle('POST', '/status', null, { id, status: 'open' }), e => e.status === 409);
  writeDecision({ decision: 'implement', key: f.key, jobStatus: 'done' });
  standings.save(path.join(dir, 'standings.json'), standings.setStatus(board, id, 'approved'));
  await api.discard(f.id, true);
  assert.equal(standings.load(path.join(dir, 'standings.json'), 'radar').items[id].status, 'open');
  assert.equal(api.readDecisions().items[f.id], undefined);
});

test('successful critique changes score but preserves reasoning and stores detail', async () => {
  const radar = await import('../tools/ai-radar.mjs'), rows = [finding()];
  const result = await radar.critiqueFindings({ findings: rows, board: standings.emptyStore('radar'),
    deadline: 500000, now: () => 0, ctx: { usageGate: async () => 0, lanes: { claude: async () => JSON.stringify([
      { key: 'r1', delta: -15, verdict: 'demote', critique: 'Privacy concern', reason: 'Too risky' }
    ]) } } });
  assert.equal(result.ok, true);
  assert.equal(rows[0].score.total, 55);
  const candidate = radar.findingCandidate(rows[0], 'r');
  assert.equal(candidate.reason, 'Reasoning pass');
  assert.equal(candidate.data.critique.critique, 'Privacy concern');
  assert.equal(candidate.data.effort, 'M');
  assert.equal(candidate.data.risks[0].kind, 'privacy');
});

test('nextRun parses 12-hour times, midnight, noon and next day', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'radar.html'), 'utf8');
  const fn = html.match(/function nextRun\(times, nowIso\) \{[\s\S]*?\n\}/)[0];
  const nextRun = vm.runInNewContext(`(${fn})`);
  const now = new Date(2026, 9, 1, 11, 0).toISOString();
  assert.equal(new Date(nextRun(['12:00 AM', '12:00 PM', '8:00 PM'], now)).getHours(), 12);
  const late = new Date(2026, 9, 1, 23, 0).toISOString();
  const next = new Date(nextRun(['12:00 AM', '8:00 AM'], late));
  assert.equal(next.getDate(), 2); assert.equal(next.getHours(), 0);
  assert.equal(nextRun(['99:00 PM'], now), undefined);
});

test('backfill remembers run IDs beyond the engine history limit', async t => {
  const radar = await import('../tools/ai-radar.mjs');
  let board = standings.emptyStore('radar');
  for (let i = 0; i < 65; i++) board = radar.mergeFindings(board, { ...run([finding()]), runId: 'run-' + i });
  const count = Object.values(board.items)[0].seenCount;
  board = radar.mergeFindings(board, { ...run([finding()]), runId: 'run-0' });
  assert.equal(Object.values(board.items)[0].seenCount, count);
  assert.equal(board.mergedRunIds.length, 65);
});
