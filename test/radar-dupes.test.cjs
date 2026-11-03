'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const standings = require('../lib/standings.cjs');
const { createRadar } = require('../lib/ai-radar.cjs');

const script = path.join(__dirname, '..', 'tools', 'radar-dedupe.mjs');
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dupes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const row = (key, title, url, id, version, kind = 'article') => ({
  key, title, url, id, kind, signals: version ? { version } : {}, score: { total: 70 }, sources: []
});
const paper = (host, version, title, id = 'paper') =>
  row(`url:https://${host}/abs/2610.37224${version}`, title, `https://${host}/abs/2610.37224${version}`, id);
const make = rows => standings.mergeRun(standings.emptyStore('radar'), rows.map(f => ({
  key: f.key, title: f.title, category: f.kind, score: 70, data: { id: f.id, url: f.url, signals: f.signals }
})), { runId: 'old', at: '2026-01-01' });
const run = (id, findings) => ({ runId: id, startedAt: '2026-01-02', findings });
const one = store => { assert.equal(Object.keys(store.items).length, 1); return Object.values(store.items)[0]; };
const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('canonical arxiv host and versions fold in either order and at merge time', async () => {
  const { foldRadarDuplicates, mergeFindings } = await import('../tools/ai-radar.mjs');
  const a = paper('export.arxiv.org', 'v1', 'Spine compiles subtask trees into structured context for coding agents', 'one');
  const b = paper('arxiv.org', 'v2', 'Spine: compiling subtask trees into structured agent context', 'two');
  for (const rows of [[a, b], [b, a]]) {
    const folded = one(foldRadarDuplicates(make(rows), { at: 'now' }));
    assert.deepEqual(new Set(folded.data.ids), new Set(['one', 'two']));
    const merged = one(mergeFindings(make([rows[0]]), run('new', [rows[1]])));
    assert.equal(merged.seenCount, 2);
  }
});

test('watched changelog and article map to repository, including without existing repo', async () => {
  const { mergeFindings, foldRadarDuplicates } = await import('../tools/ai-radar.mjs');
  const repo = row('gh:anthropics/claude-code', 'Claude Code v2.1.312', 'https://github.com/anthropics/claude-code', 'repo', '2.1.312', 'release');
  const page = row('url:https://code.claude.com/docs/en/changelog', 'Claude Code v2.1.314 adds setting', 'https://code.claude.com/docs/en/changelog', 'page', '2.1.314', 'release');
  const article = row('url:https://example.com/story', 'Claude Code v2.1.311 adds worktree fixes', 'https://example.com/story', 'article', '2.1.311', 'release');
  for (const other of [page, article]) {
    const item = one(mergeFindings(make([repo]), run('new', [other])));
    assert.equal(item.key, repo.key);
    assert.equal(item.title, other === page ? page.title : repo.title);
    assert.equal(item.data.url, other === page ? page.url : repo.url);
    assert.equal(one(mergeFindings(standings.emptyStore('radar'), run('new', [other]))).key, repo.key);
    assert.equal(one(foldRadarDuplicates(make([other, repo]))).key, repo.key);
  }
});

test('an article naming a product never retitles, re-points or reopens its repository item', async () => {
  const { mergeFindings, foldRadarDuplicates, reconcileDecisionStatuses } = await import('../tools/ai-radar.mjs');
  const repo = row('gh:anthropics/claude-code', 'Claude Code v2.1.312', 'https://github.com/anthropics/claude-code', 'repo', '2.1.312', 'release');
  const page = row('url:https://code.claude.com/docs/en/changelog', 'Claude Code v2.1.314 adds setting', 'https://code.claude.com/docs/en/changelog', 'page', '2.1.314', 'release');
  const article = { ...row('url:https://example.com/story', 'Claude Code v9.0.0 ships everything', 'https://example.com/story', 'article', '9.0.0', 'release'),
    whatsNew: 'Article text', reasoning: 'Article reasoning', plan: ['Article plan'] };
  const face = item => [item.key, item.title, item.summary, item.reason, item.data.url, item.data.id, item.data.plan];
  const stored = () => {
    const store = make([repo]);
    Object.assign(Object.values(store.items)[0], { summary: 'Repo text', reason: 'Repo reason' }).data.plan = ['Repo plan'];
    return store;
  };
  const repoFace = [repo.key, repo.title, 'Repo text', 'Repo reason', repo.url, repo.id, ['Repo plan']];
  // At scan time its newer claim only adds its finding id.
  const scannedStore = mergeFindings(stored(), run('new', [article])), scanned = one(scannedStore);
  assert.deepEqual(face(scanned), repoFace);
  assert.deepEqual(new Set(scanned.data.ids), new Set([repo.id, article.id]));
  // Folding stored copies keeps the repository's face and its dismissal, even when the article scores higher.
  for (const repoStatus of ['trashed', 'open']) {
    const store = stored();
    const copy = one(standings.mergeRun(standings.emptyStore('radar'), [{ key: article.key, title: article.title, category: 'release', score: 90,
      summary: 'Article text', reason: 'Article reasoning', data: { id: article.id, url: article.url, signals: article.signals, plan: article.plan } }], { runId: 'old', at: '2026-01-01' }));
    store.items[copy.id] = copy;
    Object.values(store.items).find(item => item.key === repo.key).status = repoStatus;
    const folded = one(foldRadarDuplicates(store, { at: 'now' }));
    assert.deepEqual([...face(folded), folded.status], [...repoFace, repoStatus]);
  }
  // A dismissal recorded on the article can't bring the repository back with the article's own version.
  const dismissed = id => ({ items: { [id]: { decision: 'dismiss', key: id === article.id ? article.key : page.key, version: '2.0.0', at: 'later' } } });
  assert.equal(one(reconcileDecisionStatuses(scannedStore, dismissed(article.id), 'now', { [article.key]: { lastVersion: 'v9.0.0' } })).status, 'trashed');
  // The official changelog still speaks for it: newer, it takes over, and its watched version brings a dismissal back.
  const pageStore = mergeFindings(stored(), run('new', [page])), withPage = one(pageStore);
  assert.deepEqual([withPage.title, withPage.data.url], [page.title, page.url]);
  assert.equal(one(reconcileDecisionStatuses(pageStore, dismissed(page.id), 'now', { [page.key]: { lastVersion: 'v3.0.0' } })).status, 'open');
});

test('multiple same-run sightings preserve the highest version and all finding IDs', async () => {
  const { mergeFindings } = await import('../tools/ai-radar.mjs');
  const makeRelease = n => row('gh:anthropics/claude-code', `Claude Code v2.1.${n}`,
    'https://github.com/anthropics/claude-code', `release-${n}`, `2.1.${n}`, 'release');
  for (const versions of [[312, 314, 311], [311, 314, 312]]) {
    const found = versions.map(makeRelease);
    const item = one(mergeFindings(standings.emptyStore('radar'), run('new', found)));
    assert.equal(item.title, 'Claude Code v2.1.314');
    assert.deepEqual(new Set(item.data.ids), new Set(found.map(f => f.id)));
    const existing = make([makeRelease(310)]);
    const again = one(mergeFindings(existing, run('new', found)));
    assert.equal(again.title, 'Claude Code v2.1.314');
    assert.deepEqual(new Set(again.data.ids), new Set(['release-310', ...found.map(f => f.id)]));
  }
});

test('similar titles merge by category but different papers and repositories never merge', async () => {
  const { foldRadarDuplicates } = await import('../tools/ai-radar.mjs');
  const a = row('url:https://example.com/a', 'Structured context improves coding agents', 'https://example.com/a', 'a');
  const b = row('url:https://example.com/b', 'Structured context improves coding agents today', 'https://example.com/b', 'b');
  const c = row('url:https://example.com/c', 'Structured context improves agents elsewhere', 'https://example.com/c', 'c');
  assert.ok(standings.similarity(a.title, b.title) >= 0.8);
  assert.ok(standings.similarity(a.title, c.title) < 0.8);
  one(foldRadarDuplicates(make([a, b])));
  assert.equal(Object.keys(foldRadarDuplicates(make([a, c])).items).length, 2);
  const p1 = paper('arxiv.org', '', a.title, 'p1');
  const p2 = row('url:https://arxiv.org/abs/2610.37225', a.title, 'https://arxiv.org/abs/2610.37225', 'p2');
  assert.equal(Object.keys(foldRadarDuplicates(make([p1, p2])).items).length, 2);
  const g1 = row('gh:a/a', a.title, 'https://github.com/a/a', 'g1');
  const g2 = row('gh:b/b', a.title, 'https://github.com/b/b', 'g2');
  assert.equal(Object.keys(foldRadarDuplicates(make([g1, g2])).items).length, 2);
});

test('status precedence, newest major exception and folded decision IDs', async () => {
  const { foldRadarDuplicates, reconcileDecisionStatuses } = await import('../tools/ai-radar.mjs');
  const a = row('url:https://example.com/a', 'Product v1.2.0', 'https://example.com/a', 'a', '1.2.0');
  const b = row('url:https://example.com/b', 'Product v2.0.0', 'https://example.com/b', 'b', '2.0.0');
  const aliases = { 'gh:x/x': { names: ['Product'], urls: [] } };
  for (const [left, right, expected] of [['open', 'trashed', 'trashed'], ['trashed', 'open', 'open'],
    ['approved', 'open', 'approved'], ['approved', 'done', 'done']]) {
    const store = make([a, b]), items = Object.values(store.items);
    items[0].status = left; items[1].status = right;
    const merged = one(foldRadarDuplicates(store, { aliases, at: 'now' }));
    assert.equal(merged.status, expected);
    assert.equal(merged.title, b.title);
    assert.equal(merged.data.url, b.url);
  }
  const folded = foldRadarDuplicates(make([a, b]), { aliases });
  const id = Object.values(folded.items)[0].data.ids.find(id => id !== Object.values(folded.items)[0].data.id);
  assert.equal(one(reconcileDecisionStatuses(folded, { items: { [id]: { decision: 'implement' } } }, 'now')).status, 'approved');
});

test('CLI dry-run, write and active scan lock', async t => {
  const dir = temp(t), file = path.join(dir, 'standings.json');
  const a = paper('export.arxiv.org', 'v1', 'Paper title', 'a'), b = paper('arxiv.org', 'v2', 'Paper title', 'b');
  standings.save(file, make([a, b]));
  const before = fs.readFileSync(file, 'utf8');
  const dry = cli('--dir', dir, '--json');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).after.total, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ running: true, pid: process.pid, startedAt: new Date().toISOString() }));
  const locked = cli('--dir', dir, '--write');
  assert.notEqual(locked.status, 0);
  assert.match(locked.stderr, /locked/i);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.unlinkSync(path.join(dir, 'status.json'));
  const write = cli('--dir', dir, '--write', '--json');
  assert.equal(write.status, 0, write.stderr);
  assert.equal(JSON.parse(write.stdout).folds.length, 1);
  one(standings.load(file, 'radar'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'))).running, false);
});

test('two runs stay deduped in standings API', async t => {
  const { mergeFindings } = await import('../tools/ai-radar.mjs');
  const dir = temp(t);
  const a = paper('export.arxiv.org', 'v1', 'Spine compiles subtask trees into structured context for coding agents', 'a');
  const b = paper('arxiv.org', 'v2', 'Spine: compiling subtask trees into structured agent context', 'b');
  const c = row('url:https://example.com/story', 'A different discovery about observability', 'https://example.com/story', 'c');
  let board = mergeFindings(standings.emptyStore('radar'), run('r1', [a, c]));
  board = mergeFindings(board, run('r2', [b]));
  standings.save(path.join(dir, 'standings.json'), board);
  const result = await createRadar({ dir, kit: dir }).handle('GET', '/standings', new URLSearchParams('status=all'));
  for (let i = 0; i < result.items.length; i++) for (let j = i + 1; j < result.items.length; j++) {
    assert.notEqual(standings.normalizeText(result.items[i].title), standings.normalizeText(result.items[j].title));
    assert.ok(standings.similarity(result.items[i].title, result.items[j].title) < 0.8);
  }
});
