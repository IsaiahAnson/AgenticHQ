'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { withLock } = require('../lib/store-lock.cjs');
const S = require('../lib/standings.cjs');
const G = require('../lib/gotcha-proposals.cjs');
const L = require('../lib/learned.cjs');

function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-lock-'));
  const dataDir = path.join(root, 'data'), lessonsDir = path.join(root, 'lessons');
  const skillsRoot = path.join(root, 'skills'), registryFile = path.join(root, 'registry.md');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(lessonsDir);
  fs.mkdirSync(path.join(skillsRoot, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, 'demo', 'SKILL.md'), '# Demo\n');
  fs.writeFileSync(path.join(root, 'config', 'lesson-skill-map.json'), JSON.stringify({ topic: ['demo'] }));
  fs.writeFileSync(path.join(lessonsDir, 'topic.md'), '- **Use node --safe** (verified 2026-10-01) [ref: one]\n');
  fs.writeFileSync(registryFile, '');
  const result = G.buildProposals({ root, skillsRoot, lessonsDir, registryFile });
  return { root, dataDir, lessonsDir, skillsRoot, registryFile, storeFile: result.standingsFile, id: Object.keys(result.store.items)[0] };
}
async function holder(file, source) {
  const child = spawn(process.execPath, ['-e', `
    const {withLock} = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'store-lock.cjs'))});
    const fs = require('node:fs');
    withLock(${JSON.stringify(file)}, () => {
      ${source}
      console.log('ready');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${errors}`)));
  });
  await Promise.race([once(child.stdout, 'data'), exit.then(() => { throw new Error('child exited before ready'); })]);
  return { exit };
}

test('a busy board returns 503 unchanged and succeeds after the lock is released', async () => {
  const r = rig(), before = fs.readFileSync(r.storeFile, 'utf8');
  const { exit } = await holder(r.storeFile, '');
  const api = L.forServer({ kit: r.root, ...r, lockTimeoutMs: 300 });
  await assert.rejects(api.handle('POST', '/status', null, { id: r.id, status: 'trashed' }),
    e => e.code === 'STORE_BUSY' && e.status === 503 && e.message === 'HQ is updating the Learned board. Try again in a minute.');
  assert.equal(fs.readFileSync(r.storeFile, 'utf8'), before);
  await exit;
  assert.equal((await api.handle('POST', '/status', null, { id: r.id, status: 'trashed' })).item.status, 'trashed');
});

test('proposal run waits for a concurrent status update before loading', async () => {
  const r = rig();
  const { exit } = await holder(r.storeFile, `
    const file = ${JSON.stringify(r.storeFile)};
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.items[${JSON.stringify(r.id)}].status = 'done';
    fs.writeFileSync(file, JSON.stringify(state));
  `);
  const started = Date.now();
  const result = G.buildProposals({ ...r, lockTimeoutMs: 5000 });
  assert.ok(Date.now() - started > 700);
  assert.equal(result.store.items[r.id].status, 'done');
  assert.equal(S.load(r.storeFile, 'learned').items[r.id].status, 'done');
  await exit;
});

test('nested locks, stale locks and cleanup on success or exception', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-')), file = path.join(dir, 'board.json'), lock = file + '.lock';
  assert.equal(withLock(file, () => withLock(file, () => 'nested', { timeoutMs: 0 })), 'nested');
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => withLock(file, () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(fs.existsSync(lock), false);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  await once(child, 'exit');
  fs.writeFileSync(lock, JSON.stringify({ pid, at: Date.now() }));
  assert.equal(withLock(file, () => 'dead', { timeoutMs: 0 }), 'dead');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(withLock(file, () => 'old', { timeoutMs: 0, staleMs: 30000 }), 'old');
  assert.equal(fs.existsSync(lock), false);
});
