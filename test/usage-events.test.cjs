'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const events = require('../lib/hq-events.cjs');
const usage = require('../lib/usage-meters.cjs');

const NOW = Date.parse('2026-10-29T12:00:00Z'), RESET = NOW + 3600000;
const meter = (used, reset = RESET) => [{ id: 'codex', name: 'Codex', windows: [{ label: '5h', used, resetsAt: reset }] }];

test('80 -> 90 replaces high with low, reset -> 95 creates only the new low', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-events-')), file = path.join(dir, 'events.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const emit = readings => usage.thresholdEvents(readings, NOW).forEach(item => events.append(item.event, { ...item.options, file }));
  emit(meter(80));
  assert.deepEqual(events.list({ file }).map(row => row.type), ['usage.high']);
  emit(meter(90));
  assert.deepEqual(events.list({ file }).map(row => row.type), ['usage.low']);
  emit(meter(95, RESET + 5 * 3600000));
  assert.deepEqual(events.list({ file }).map(row => row.type), ['usage.low', 'usage.low']);
  assert.equal(events.list({ file }).some(row => row.type === 'usage.high'), false);
});

test('run budget verdict blocks metered 90 percent and suggests a free configured fallback', () => {
  const stats = { meters: [
    { id: 'codex', windows: [{ label: '5h', used: 90, resetsAt: RESET }] },
    { id: 'claude', windows: [{ label: '5h', used: 40 }] }
  ] };
  const profiles = { agents: [{ id: 'codex', fallbacks: ['claude'] }, { id: 'claude' }] };
  assert.deepEqual(usage.runBudgetVerdict('codex', stats, profiles, NOW), {
    allowed: false, error: 'usage low', agent: 'codex', used: 90, resets: new Date(RESET).toISOString(), suggest: 'claude'
  });
  assert.equal(usage.runBudgetVerdict('deepseek', stats, profiles, NOW).allowed, true);
});
