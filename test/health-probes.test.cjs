'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { heartbeat, createHealthProbes } = require('../lib/health-probes.cjs');

const NOW = Date.parse('2026-10-29T12:00:00Z');

test('heartbeat missing is unknown; older than three beats is stale', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-beat-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(heartbeat(path.join(dir, 'missing.json'), { now: NOW }).status, 'unknown');
  const file = path.join(dir, 'qmd.json');
  fs.writeFileSync(file, JSON.stringify({ pid: 7, startedAt: '2026-10-29T11:00:00Z', lastBeat: '2026-10-29T11:59:20Z', beatMs: 10000 }));
  assert.deepEqual(heartbeat(file, { now: NOW }).status, 'stale');
  fs.writeFileSync(file, JSON.stringify({ pid: 7, lastBeat: '2026-10-29T11:59:40Z', beatMs: 10000 }));
  assert.equal(heartbeat(file, { now: NOW }).status, 'fresh');
});

test('CASS serves cached state and refreshes in the background once per TTL', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-probe-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let calls = 0, clock = NOW;
  const probes = createHealthProbes({ heartbeatDir: dir, now: () => clock, runner: async (_command, args, options) => {
    calls += 1; assert.deepEqual(args, ['health', '--json']); assert.equal(options.timeout, 5000);
    return JSON.stringify({ status: 'rebuilding', healthy: true, doctor_summary: { health_class: 'healthy' } });
  } });
  const first = probes.snapshot({ qmd: true });
  assert.equal(first.companions.cass, null, 'first request returns immediately without waiting for the command');
  await probes.refresh('cass');
  assert.equal(probes.snapshot({ qmd: true }).companions.cass, true);
  assert.equal(calls, 1);
  clock += 61000;
  probes.snapshot({ qmd: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

test('a stale companion heartbeat overrides an otherwise up port', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-probe-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'qmd.json'), JSON.stringify({ lastBeat: '2026-10-29T11:00:00Z', beatMs: 10000 }));
  const snapshot = createHealthProbes({ heartbeatDir: dir, now: () => NOW, runner: async () => '{}' }).snapshot({ qmd: true });
  assert.equal(snapshot.companions.qmd, 'stale');
  assert.equal(snapshot.details.qmd.heartbeat, 'stale');
});
