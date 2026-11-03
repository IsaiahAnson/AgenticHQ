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

async function waitForHealth(port, child, output, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output()}`);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); if (response.ok) return response.json(); }
    catch (_) { }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server did not become healthy: ${output()}`);
}

// Roomy limits (here and in waitForHealth): the full suite runs test files side by side, and on a busy PC this test
// ran past 20 s while taking about 7 s alone.
test('server boots on spare ports and core read/action contracts work', { timeout: 60000 }, async t => {
  let port, brainPort;
  try { port = await freePort(); brainPort = await freePort(); }
  catch (error) { t.skip(`spare port could not be bound: ${error.message}`); return; }
  if ([50000, 50201].includes(port) || [50000, 50201, port].includes(brainPort)) { t.skip('free-port allocator returned a reserved/live HQ port'); return; }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-server-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'os-config.json'), 'utf8'));
  const codexCard = (config.skills || []).find(skill => skill.agent === 'codex');
  const readings = path.join(temp, 'usage.json');
  fs.writeFileSync(readings, JSON.stringify({ codex: { agent: 'codex', source: 'server-test', t: Date.now() + 60000,
    windows: [{ label: '5h', used: 95, resetsAt: Date.now() + 3600000 }] } }));

  let logs = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, windowsHide: true,
    env: { ...process.env, PORT: String(port), BRAIN_PORT: String(brainPort), HQ_USAGE_READINGS: readings,
      HQ_EVENTS_FILE: path.join(temp, 'events.jsonl') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });

  let health;
  try { health = await waitForHealth(port, child, () => logs); }
  catch (error) {
    if (/EADDRINUSE|already in use/i.test(String(error.message))) { t.skip('spare port was taken before server bind'); return; }
    throw error;
  }
  assert.equal(health.ok, true);
  assert.equal(health.port, port);

  const routines = await (await fetch(`http://127.0.0.1:${port}/api/routines`)).json();
  const ran = (routines.switches || []).filter(item => item.pulse?.lastRun?.at);
  assert.equal(ran.filter(item => item.lastRunAt == null).length, 0);

  const bench = await (await fetch(`http://127.0.0.1:${port}/api/bench`)).json();
  assert.ok(bench.orcaKeeps && Number.isInteger(bench.orcaKeeps.count));
  assert.ok(Array.isArray(bench.orcaKeeps.items));

  const before = fs.readdirSync(path.join(ROOT, 'os-runs')).filter(name => name.startsWith('unknown-boot-test-'));
  const unknown = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'unknown-boot-test', model: 'sonnet', effort: 'medium' }) });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, 'unknown skill');
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'os-runs')).filter(name => name.startsWith('unknown-boot-test-')), before);

  if (codexCard) {
    const model = String(config.models[codexCard.model ?? 1]), effort = String(config.efforts[codexCard.effort ?? 1]);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: codexCard.id, model, effort }) });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.error, 'usage low'); assert.equal(body.agent, 'codex'); assert.equal(body.used, 95); assert.ok(body.suggest);
    assert.equal(body.job, undefined);
  }

  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
});
