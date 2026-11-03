'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { textKey, duplicateReport, nearDuplicatePairs, repeatAlert } = require('../lib/ranked-dupes.cjs');
const standings = require('../lib/standings.cjs');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-dupes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The CLI tests also read two views from a stand-in local add-on that hides their text (lib/addons.cjs). */
const ADDONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-dupes-addons-'));
fs.mkdirSync(path.join(ADDONS_DIR, 'private'));
fs.writeFileSync(path.join(ADDONS_DIR, 'private', 'addon.json'), JSON.stringify({ rankedViews: [
  { endpoint: '/api/standings/private?status=ranked&limit=500', hideText: true },
  { endpoint: '/api/standings/private?status=all&limit=500', hideText: true }] }));
process.on('exit', () => fs.rmSync(ADDONS_DIR, { recursive: true, force: true }));

test('text keys normalize leading dash, case, punctuation and empty text', () => {
  assert.equal(textKey('- Café, WORKERS!'), 'cafe workers');
  assert.equal(textKey(' -   '), '');
  assert.equal(textKey(null), '');
});

test('duplicate report counts groups and extra copies, excluding empty keys', () => {
  const items = [{ id: 'a', title: '- Hello, world!' }, { key: 'b', title: 'HELLO WORLD' },
    { title: 'hello world' }, { title: '   ' }, { title: 'Other' }];
  assert.deepEqual(duplicateReport(items), { total: 5, unique: 2, duplicateTexts: 1, extraCopies: 2,
    groups: [{ key: 'hello world', ids: ['a', 'b', 2] }] });
  assert.equal(duplicateReport([{ text: 'one' }, { text: 'ONE!' }], { textOf: x => x.text }).duplicateTexts, 1);
});

test('near duplicates honor inclusive thresholds and exclude exact and empty keys', () => {
  const items = [{ id: 'a', title: 'alpha beta gamma delta' },
    { id: 'b', title: 'alpha beta gamma delta epsilon' },
    { id: 'c', title: '- ALPHA BETA GAMMA DELTA!' }, { id: 'd', title: '' }];
  assert.deepEqual(nearDuplicatePairs(items), [
    { a: 'a', b: 'b', similarity: 0.8 }, { a: 'b', b: 'c', similarity: 0.8 }
  ]);
  assert.deepEqual(nearDuplicatePairs(items, { threshold: 0.81 }), []);
  const sorted = nearDuplicatePairs([{ title: 'alpha beta' }, { title: 'alpha beta gamma' },
    { title: 'alpha beta gamma delta' }], { threshold: 0.5 });
  assert.deepEqual(sorted.map(pair => pair.similarity), [0.75, 2 / 3, 0.5]);
});

function cli(base, ...args) {
  return cliEnv({}, base, ...args);
}

// RANKED_DUPES_RETRY_MS: tests don't wait out the 2s pause before a failed view is read again.
function cliEnv(env, base, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'ranked-dupes.mjs'),
      '--base', base, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RANKED_DUPES_RETRY_MS: '10', HQ_ADDONS_DIR: ADDONS_DIR, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI reports unique and duplicate endpoints without revealing hidden-view text', async t => {
  let duplicate = false;
  const server = http.createServer((req, res) => {
    const hidden = req.url.startsWith('/api/standings/private');
    const title = hidden ? 'SECRET PRIVATE TEXT Example' : 'Visible example';
    const items = duplicate ? [{ title }, { title }] : [{ title }];
    const body = req.url === '/api/learned'
      ? { pending: duplicate ? [{ text: title }, { text: title }] : [{ text: title }], standings: { items } }
      : { items };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let result = await cli(base, '--json', '--show-text');
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).length, 7);
  assert.doesNotMatch(result.stdout, /SECRET PRIVATE TEXT/);
  duplicate = true;
  result = await cli(base, '--json', '--show-text');
  assert.equal(result.code, 1);
  const rows = JSON.parse(result.stdout);
  assert.ok(rows.every(row => row.duplicateTexts > 0));
  assert.match(result.stdout, /visible example/);
  assert.doesNotMatch(result.stdout, /SECRET PRIVATE TEXT|secret private text/);
  assert.ok(rows.filter(row => row.endpoint.includes('/private')).every(row => !('texts' in row)));
  result = await cli(base, '--show-text');
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stdout, /SECRET PRIVATE TEXT|secret private text/);
});

test('CLI returns 2 when the server is unreachable', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const result = await cli(`http://127.0.0.1:${port}`, '--json');
  assert.equal(result.code, 2);
  assert.ok(JSON.parse(result.stdout).every(row => !row.ok));
});

test('CLI reads a dropped view once more before counting it as failed', async t => {
  let drops = 1;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/learned' && drops > 0) { drops--; req.socket.destroy(); return; }
    const items = [{ title: 'Visible example' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/learned' ? { pending: [{ text: 'Visible example' }], standings: { items } } : { items }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let result = await cli(base, '--json');
  assert.equal(result.code, 0);
  let rows = JSON.parse(result.stdout);
  assert.ok(rows.every(row => row.ok));
  assert.match(rows.find(row => row.endpoint === '/api/learned').firstError, /^fetch failed/);
  assert.equal(rows.filter(row => 'firstError' in row).length, 1);
  drops = 2;
  result = await cli(base, '--json');
  assert.equal(result.code, 2, 'a view that fails both reads still counts as failed');
  rows = JSON.parse(result.stdout);
  const learned = rows.find(row => row.endpoint === '/api/learned');
  assert.equal(learned.ok, false);
  assert.match(learned.error, /^fetch failed/);
  assert.match(learned.firstError, /^fetch failed/);
  assert.equal(rows.filter(row => !row.ok).length, 1);
});

test('repeat alert pushes exact repeats, holds look-alikes and read failures for the digest, and names no item text', () => {
  const row = (endpoint, extra = 0, near = 0) => ({ endpoint, ok: true, total: 5, unique: 5 - extra, duplicateTexts: extra ? 1 : 0, extraCopies: extra, nearPairs: near });
  assert.equal(repeatAlert([row('/api/learned/standings?status=ranked&limit=500'), row('/api/learned')]), null);
  const pushed = repeatAlert([row('/api/learned/standings?status=ranked&limit=500', 2), row('/api/radar/standings?status=all&limit=500', 0, 1),
    { ...row('/api/standings/private?status=all&limit=500', 1), texts: ['SECRET PRIVATE TEXT'] }]);
  assert.equal(pushed.priority, 'normal');
  assert.equal(pushed.title, 'HQ repeats are back: Learned, Private');
  assert.match(pushed.text, /^Learned ranked: 2 extra copies; Radar all: 1 look-alike pair; Private all: 1 extra copy\. /);
  assert.doesNotMatch(JSON.stringify(pushed), /SECRET PRIVATE TEXT/);
  const held = repeatAlert([row('/api/radar/standings?status=ranked&limit=500', 0, 2)]);
  assert.deepEqual([held.priority, held.title], ['low', 'HQ look-alike items: Radar']);
  const failed = repeatAlert([row('/api/learned'), { endpoint: '/api/learned/standings?status=all&limit=500', ok: false, error: 'HTTP 500' }]);
  assert.deepEqual([failed.priority, failed.title], ['low', "HQ repeat check couldn't read 1 view"]);
  assert.match(failed.text, /^Learned all: couldn't read \(HTTP 500\)\. /);
});

test('CLI --alert pushes once a day through the attention gate and logs counts only', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ranked-dupes-alert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let duplicate = true;
  const pushes = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/ntfy') {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => { pushes.push(JSON.parse(raw)); res.writeHead(200); res.end('{}'); });
      return;
    }
    const title = req.url.startsWith('/api/standings/private') ? 'SECRET PRIVATE TEXT Example' : 'Visible example';
    const items = duplicate ? [{ title }, { title }] : [{ title }];
    const body = req.url === '/api/learned' ? { pending: items.map(item => ({ text: item.title })), standings: { items } } : { items };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = path.join(dir, 'os-config.json');
  fs.writeFileSync(config, JSON.stringify({ attention: { ntfy: `${base}/ntfy`, topic: 'test' } }));
  const env = { HQ_CONFIG: config, HQ_ATTENTION_DIR: path.join(dir, 'attention'), HQ_EVENTS_FILE: path.join(dir, 'events.jsonl') };
  const log = path.join(dir, 'runs', 'ranked-dupes.jsonl');
  assert.equal((await cliEnv(env, base, '--alert', '--log', log)).code, 1);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].priority, 3);
  assert.equal(pushes[0].title, 'HQ repeats are back: Learned, Radar, Private');
  assert.doesNotMatch(JSON.stringify(pushes), /secret private text|visible example/i);
  assert.equal((await cliEnv(env, base, '--alert', '--log', log, '--show-text')).code, 1);
  assert.equal(pushes.length, 1, 'a second run the same day does not push again');
  duplicate = false;
  assert.equal((await cliEnv(env, base, '--alert', '--log', log)).code, 0);
  assert.equal(pushes.length, 1);
  const written = fs.readFileSync(log, 'utf8');
  assert.deepEqual(written.trim().split('\n').map(line => JSON.parse(line).alert?.reason ?? null), ['sent', 'duplicate', null]);
  assert.doesNotMatch(written, /secret private text|visible example/i);
});

test('Learned creation path produces no duplicate texts on any list', async t => {
  const root = temp(t), lessonsDir = path.join(root, 'lessons'), skillsRoot = path.join(root, 'skills');
  const dataDir = path.join(root, 'data'), registryFile = path.join(root, 'registry.md');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(lessonsDir); fs.mkdirSync(skillsRoot);
  const skills = ['orchestration', 'orca-cli', 'worker-router'];
  fs.writeFileSync(path.join(root, 'config', 'lesson-skill-map.json'), JSON.stringify({ orca: skills }));
  for (const skill of skills) {
    fs.mkdirSync(path.join(skillsRoot, skill));
    fs.writeFileSync(path.join(skillsRoot, skill, 'SKILL.md'), '# Skill\n\n## Gotchas\n');
  }
  fs.writeFileSync(path.join(lessonsDir, 'orca.md'),
    '- **Check worker delivery before retrying.** Example detail.\n- **Preserve dispatch identity when reporting.** Example detail.\n');
  fs.writeFileSync(registryFile, [
    '| Fingerprint | Symptom | Workaround or fix | Scope | Count | Status | Last seen | Evidence |',
    '|---|---|---|---|---|---|---|---|',
    '| `worker-example` | Orca workers miss replies | Check inbox | workers | 2 | open | 2026-11-01 | fixture |'
  ].join('\n'));
  const { buildProposals } = require('../lib/gotcha-proposals.cjs');
  for (const now of ['2026-11-01T12:00:00Z', '2026-11-02T12:00:00Z']) {
    buildProposals({ root, skillsRoot, lessonsDir, registryFile, now: new Date(now) });
  }
  const learned = require('../lib/learned.cjs');
  const api = learned.forServer({ kit: root, lessonsDir, dataDir, skillsRoot });
  const lists = {};
  for (const status of ['all', 'ranked']) {
    const result = await api.handle('GET', '/standings', new URLSearchParams(`status=${status}&limit=500`));
    assert.ok(result.items.length >= 2, `${status} fixture must produce lesson items`);
    lists[status] = duplicateReport(result.items).duplicateTexts;
  }
  const pending = learned.collect({ kit: root, lessonsDir, dataDir }).pending;
  assert.ok(pending.length >= 2, 'pending fixture must produce lesson items');
  lists.pending = duplicateReport(pending, { textOf: item => item.text }).duplicateTexts;
  assert.deepEqual(lists, { all: 0, ranked: 0, pending: 0 }, 'Learned lists must not repeat a lesson per skill');
});

test('Radar creation path produces no duplicate texts in all and ranked views', async t => {
  const dir = temp(t), { mergeFindings } = await import('../tools/ai-radar.mjs');
  const finding = { id: 'example', key: 'example-key', title: 'Example finding', kind: 'tool',
    url: 'https://example.invalid/finding', score: { total: 50 }, sources: [] };
  let store = standings.emptyStore('radar');
  for (const [runId, startedAt] of [['one', '2026-11-01T00:00:00Z'], ['two', '2026-11-02T00:00:00Z']]) {
    store = mergeFindings(store, { runId, startedAt, findings: [finding] });
  }
  standings.save(path.join(dir, 'standings.json'), store);
  const radar = require('../lib/ai-radar.cjs').createRadar({ dir, kit: dir });
  for (const status of ['all', 'ranked']) {
    const result = await radar.handle('GET', '/standings', new URLSearchParams(`status=${status}&limit=500`));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].seenCount, 2);
    assert.equal(duplicateReport(result.items).duplicateTexts, 0);
  }
});
