'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const usage = require('../lib/usage-meters.cjs');
const { meterVerdict } = require('../lib/usage-verdict.cjs');

const NOW = Date.parse('2026-10-29T18:00:00Z');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-usage-'));
  const claudeRoot = path.join(root, 'claude'), codexRoot = path.join(root, 'codex');
  const claudeHistory = path.join(root, 'history.json'), readingsFile = path.join(root, 'readings.json');
  fs.mkdirSync(path.join(claudeRoot, 'project'), { recursive: true });
  fs.mkdirSync(path.join(codexRoot, '2026', '10', '29'), { recursive: true });
  return { root, claudeRoot, codexRoot, claudeHistory, readingsFile, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const noCopilot = (_cmd, _args, _options, cb) => cb(new Error('unavailable'));
const noHerder = async () => { throw new Error('unavailable'); };

test('Claude uses the newest of desktop history and agent-reported readings', async t => {
  const f = fixture(); t.after(f.cleanup);
  fs.writeFileSync(f.claudeHistory, JSON.stringify({ samples: [{ t: NOW - 20 * 60000, u: { fh: 7, sd: 10 } }] }));
  fs.writeFileSync(f.readingsFile, JSON.stringify({ claude: { agent: 'claude', t: NOW - 5 * 60000, source: 'usage-check', windows: [{ label: '5h', used: 4, resetsAt: NOW + 3 * 36e5 }, { label: 'week', used: 12, resetsAt: null }] } }));
  const reader = usage.createUsageMeters({ ...f, now: () => NOW, execFile: noCopilot, fetch: noHerder });
  let meter = (await reader.read()).meters.find(m => m.id === 'claude');
  assert.equal(meter.windows.find(w => w.label === '5h').used, 4);
  fs.writeFileSync(f.claudeHistory, JSON.stringify({ samples: [{ t: NOW - 60000, u: { fh: 9, sd: 13 } }] }));
  meter = (await reader.read({ fresh: true })).meters.find(m => m.id === 'claude');
  assert.equal(meter.windows.find(w => w.label === '5h').used, 9);
});

test('Codex chooses newest by reading time, not source priority', async t => {
  const f = fixture(); t.after(f.cleanup);
  const rollout = path.join(f.codexRoot, '2026', '10', '29', 'rollout-x.jsonl');
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: new Date(NOW - 60000).toISOString(), payload: { rate_limits: {
    plan_type: 'plus', primary: { used_percent: 33, window_minutes: 300, resets_at: (NOW + 36e5) / 1000 }, secondary: { used_percent: 40, window_minutes: 10080 }
  } } }) + '\n');
  const herder = async () => ({ ok: true, text: async () => 'data: ' + JSON.stringify({ result: { structuredContent: { checkedAt: new Date(NOW - 10 * 60000).toISOString(), providers: [{ provider: 'codex', state: 'reported', checkedAt: new Date(NOW - 10 * 60000).toISOString(), details: { primary_used: 20, secondary_used: 30 } }] } } }) });
  const meter = (await usage.createUsageMeters({ ...f, now: () => NOW, execFile: noCopilot, fetch: herder }).read()).meters.find(m => m.id === 'codex');
  assert.equal(meter.windows.find(w => w.label === '5h').used, 33);
  assert.equal(meter.fromLogs, true);
});

test('idleSince keeps an old reading usable; later activity makes it stale', () => {
  const old = { id: 'claude', t: NOW - 2 * 36e5, idleSince: true, stale: true, windows: [{ label: '5h', used: 8 }] };
  assert.deepEqual(meterVerdict(old, '5h', { now: NOW }).verdict, 'ok');
  assert.equal(meterVerdict(old, '5h', { now: NOW }).idle, true);
  assert.equal(meterVerdict({ ...old, idleSince: false }, '5h', { now: NOW }).verdict, 'stale');
});

test('Claude activity after a reading changes the local meter from idle to stale', async t => {
  const f = fixture(); t.after(f.cleanup);
  const readingAt = NOW - 2 * 36e5;
  fs.writeFileSync(f.claudeHistory, JSON.stringify({ samples: [{ t: readingAt, u: { fh: 8, sd: 9 } }] }));
  const transcript = path.join(f.claudeRoot, 'project', 'session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: 'test' } }) + '\n');
  fs.utimesSync(transcript, new Date(readingAt + 60000), new Date(readingAt + 60000));
  const reader = usage.createUsageMeters({ ...f, now: () => NOW, execFile: noCopilot, fetch: noHerder });
  let meter = (await reader.read()).meters.find(m => m.id === 'claude');
  assert.deepEqual([meter.idleSince, meter.stale], [true, false]);
  fs.utimesSync(transcript, new Date(readingAt + 3 * 60000), new Date(readingAt + 3 * 60000));
  meter = (await reader.read({ fresh: true })).meters.find(m => m.id === 'claude');
  assert.deepEqual([meter.idleSince, meter.stale], [false, true]);
});

test('passed reset still rolls over before verdict and is not stale', () => {
  const meter = { id: 'codex', t: NOW - 2 * 36e5, windows: [{ label: '5h', used: 88, resetsAt: NOW - 60000 }] };
  const w = meter.windows[0], span = 5 * 36e5;
  meter.windows[0] = { ...w, used: 0, lastUsed: w.used, rolledOver: true, estimated: true, resetsAt: w.resetsAt + (Math.floor((NOW - w.resetsAt) / span) + 1) * span };
  assert.equal(meterVerdict(meter, '5h', { now: NOW }).verdict, 'ok');
});

test('reported reading validation rejects bad agents and percentages', () => {
  assert.throws(() => usage.validateUsageReading({ agent: 'other', source: 'x', windows: [{ label: '5h', used: 2 }] }), /agent/);
  assert.throws(() => usage.validateUsageReading({ agent: 'claude', source: 'x', windows: [{ label: '5h', used: 101 }] }), /0 to 100/);
  assert.deepEqual(usage.validateUsageReading({ agent: 'copilot', source: 'self', windows: [{ label: 'credits', used: 12, resetsAt: '2026-11-01T00:00:00Z' }] }, NOW), {
    agent: 'copilot', source: 'self', t: NOW, windows: [{ label: 'credits', used: 12, resetsAt: Date.parse('2026-11-01T00:00:00Z') }]
  });
});

test('usage reading endpoint guard recognizes loopback addresses only', () => {
  assert.equal(usage.isLoopbackAddress('127.0.0.1'), true);
  assert.equal(usage.isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(usage.isLoopbackAddress('192.168.1.10'), false);
  assert.equal(usage.isLoopbackAddress('::ffff:192.168.1.10'), false);
});
