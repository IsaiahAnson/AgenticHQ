'use strict';
// Static files: an encoded slash (..%2f) must not reach files outside assets/, brain/, views/ or the ring folder.
// Also checks the HQ_TOKEN shared secret. The server runs in demo mode with a temp config, and a stub answers
// on the brain port so no Second Brain engine is started.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const TEST_TOKEN = 'static-paths-test-value';

const portFree = port => new Promise(resolve => {
  const s = net.createServer(); s.unref();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
async function highPort(skip = []) {
  for (let i = 0; i < 50; i++) {
    const port = 51001 + Math.floor(Math.random() * 8000);
    if (!skip.includes(port) && await portFree(port)) return port;
  }
  return null;
}

test('encoded dot segments cannot leave the public folders, and HQ_TOKEN works', { timeout: 60000 }, async t => {
  const port = await highPort(), brainPort = await highPort([port]);
  if (!port || !brainPort) { t.skip('no free port above 51000'); return; }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-static-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const ring = path.join(temp, 'ring');
  fs.mkdirSync(path.join(ring, '_trash'), { recursive: true });
  fs.writeFileSync(path.join(ring, 'ok.html'), '<html><head></head><body>ok</body></html>');
  fs.writeFileSync(path.join(ring, '_trash', 'gone.html'), '<html><head></head><body>gone</body></html>');
  const configFile = path.join(temp, 'os-config.json');
  fs.writeFileSync(configFile, JSON.stringify({ artifactsDir: ring }));

  const brain = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise(resolve => brain.listen(brainPort, '127.0.0.1', resolve));
  t.after(() => brain.close());

  const env = { ...process.env, PORT: String(port), BRAIN_PORT: String(brainPort), HQ_CONFIG: configFile, HQ_DEMO: '1',
    HQ_EVENTS_FILE: path.join(temp, 'events.jsonl'), HQ_TOKEN: TEST_TOKEN };
  delete env.RUBRIC_TOKEN; delete env.ANTHROPIC_ADMIN_KEY; delete env.ANTHROPIC_API_KEY;
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  let up = false;
  while (!up && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${logs}`);
    try { up = (await fetch(`${base}/api/health`, { headers: { 'x-hq-token': TEST_TOKEN }, signal: AbortSignal.timeout(1500) })).ok; } catch (_) { }
    if (!up) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(up, `server did not become healthy: ${logs}`);

  // a raw request line, so nothing on the client side normalises the path
  const get = (p, method = 'GET') => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `localhost:${port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject).end();
  });

  for (const p of ['/assets/..%2fos-config.json', '/assets/%2e%2e%2fos-config.json', '/assets/..%2fpackage.json',
    '/brain/..%2f..%2fpackage.json', '/views/.%2f..%2fserver.js', '/assets/..%5cos-config.json',
    '/artifacts/x%2f..%2f_trash%2fgone.html', '/artifacts/_TRASH/gone.html', '/artifacts/..%2fos-config.json']) {
    const code = await get(p);
    assert.ok(code === 404 || code === 403, `${p} answered ${code}`);
  }
  assert.equal(await get('/assets/token.js'), 200);
  // HEAD, because a GET of a ring page is logged to data/artifact-opens.jsonl in the HQ folder
  assert.equal(await get('/artifacts/ok.html', 'HEAD'), 200);

  assert.equal((await fetch(`${base}/api/health`)).status, 401);
  assert.equal((await fetch(`${base}/api/health`, { headers: { 'x-hq-token': 'wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/health`, { headers: { 'x-rubric-token': TEST_TOKEN } })).status, 200);
  assert.match(logs, /Shared secret \(HQ_TOKEN\): on/);
  assert.ok(!logs.includes(TEST_TOKEN), 'the token value is never printed');

  child.kill('SIGTERM');
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
});
