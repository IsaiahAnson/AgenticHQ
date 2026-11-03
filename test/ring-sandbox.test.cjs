'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.unref();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
});

async function waitForHealth(port, child, output, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output()}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); if (response.ok) return; }
    catch (_) { }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${output()}`);
}

test('ring pages are sandboxed and their Origin "null" cannot drive HQ actions', { timeout: 20000 }, async t => {
  let port, brainPort;
  try { port = await freePort(); brainPort = await freePort(); }
  catch (error) { t.skip(`spare port could not be bound: ${error.message}`); return; }
  if ([50000, 50201].includes(port) || [50000, 50201, port].includes(brainPort)) { t.skip('free-port allocator returned a reserved/live HQ port'); return; }
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'os-config.json'), 'utf8'));
  const ringDir = path.join(ROOT, config.artifactsDir || 'artifacts');
  const page = (fs.existsSync(ringDir) ? fs.readdirSync(ringDir) : []).find(name => /\.html$/i.test(name));
  if (!page) { t.skip('no ring page to fetch'); return; }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-ring-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, windowsHide: true,
    env: { ...process.env, PORT: String(port), BRAIN_PORT: String(brainPort), HQ_EVENTS_FILE: path.join(temp, 'events.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  try { await waitForHealth(port, child, () => logs); }
  catch (error) { if (/EADDRINUSE|already in use/i.test(String(error.message))) { t.skip('spare port was taken before server bind'); return; } throw error; }

  const base = `http://127.0.0.1:${port}`;
  const ring = await fetch(`${base}/artifacts/${encodeURIComponent(page)}`);
  assert.equal(ring.status, 200);
  const csp = ring.headers.get('content-security-policy') || '';
  assert.match(csp, /^sandbox\b/);
  assert.ok(csp.includes('allow-scripts') && csp.includes('allow-popups-to-escape-sandbox'));
  assert.ok(!csp.includes('allow-same-origin'));
  const html = await ring.text();
  assert.ok(!html.includes('rubric-token'));
  const nonce = await fetch(`${base}/api/ring-nonce`, { headers: { origin: 'null' } });
  assert.equal(nonce.headers.get('access-control-allow-origin'), null);
  const { ring: ringNonce } = await nonce.json();
  assert.match(ringNonce, /^[0-9a-f]{32}$/);
  if (html.includes('artifact-review.js')) assert.ok(html.includes(`data-ring="${ringNonce}"`));

  const sidecar = page.replace(/\.html$/i, '.json');
  if (fs.existsSync(path.join(ROOT, config.artifactsDir || 'artifacts', sidecar))) assert.match((await fetch(`${base}/artifacts/${encodeURIComponent(sidecar)}`)).headers.get('content-security-policy') || '', /^sandbox\b/);

  const json = { 'content-type': 'application/json', origin: 'null' };
  for (const [route, body] of [['/api/run', { id: 'x', model: 'sonnet', effort: 'medium' }], ['/api/save-format', { artifact: page, name: 'ring-sandbox-test', model: 'sonnet', effort: 'medium' }],
    ['/api/apply-comments', { artifact: page, comments: '1. test', model: 'sonnet', effort: 'medium' }], ['/api/open', { path: 'ring-sandbox-test-missing' }], ['/api/artifact-remove', { file: 'ring-sandbox-test-missing.html' }]]) {
    const r = await fetch(base + route, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal(r.status, 403, route);
    assert.equal(r.headers.get('access-control-allow-origin'), null, route);
  }

  const confirm = await fetch(`${base}/assets/review-confirm.html`);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.headers.get('content-security-policy'), null);

  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
});
