'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'week-in-hq.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'week');
const NOW = '2026-10-31T12:00:00.000Z';

test('the tool writes week facts from a fixture dir without touching live sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'week-facts-'));
  const out = path.join(dir, 'week-facts.json');
  try {
    const line = execFileSync(process.execPath, [TOOL, '--fixture', FIXTURES, '--days', '7', '--now', NOW, '--out', out], { cwd: dir, encoding: 'utf8' });
    assert.match(line.trim(), /^week-facts: .*week-facts\.json \(4 commits, 4 agent runs\)$/);

    const facts = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(facts.generatedAt, NOW);
    assert.equal(facts.from, '2026-10-24T12:00:00.000Z');
    assert.equal(facts.to, NOW);
    assert.equal(facts.days, 7);

    assert.equal(facts.agents.runs, 4);
    assert.equal(facts.agents.succeeded, 2);
    assert.equal(facts.agents.failed, 1);
    assert.equal(facts.agents.needsAction, 1);
    assert.equal(facts.agents.hours, 1.9);
    assert.deepEqual(facts.agents.byAgent, { codex: 2, claude: 1, gemini: 1 });
    assert.equal(facts.agents.busiestDay, '2026-10-30');

    assert.equal(facts.automations.runs, 4);
    assert.equal(facts.automations.healthy, 1);
    assert.equal(facts.automations.needsAction, 3);
    assert.deepEqual(facts.automations.topNeedsAction, [{ routine: 'email-triage', count: 2 }, { routine: 'deps-check', count: 1 }]);

    assert.deepEqual(facts.ring, { created: 2, opened: 1, notOpened: ['Email triage'] });
    assert.equal(facts.radar.runs, 2);
    assert.equal(facts.radar.findings, 5);
    assert.deepEqual(facts.radar.byVerdict, { adopt: 1, trial: 2, watch: 1, skip: 1 });
    assert.deepEqual(facts.radar.top, ['Use node:test', 'Try Biome', 'Try Ruff']);
    assert.deepEqual(facts.radar.decisions, { implement: 1, later: 1, dismiss: 1 });

    assert.equal(facts.shipping.commits, 4);
    assert.deepEqual(facts.shipping.repos, [
      { repo: 'hq', commits: 3, insertions: 148, deletions: 36 },
      { repo: 'tools', commits: 1, insertions: 40, deletions: 0 }
    ]);
    assert.deepEqual(facts.shipping.byDay, { '2026-10-29': 1, '2026-10-30': 2, '2026-10-31': 1 });
    assert.equal(facts.shipping.longestStreakDays, 3);

    assert.deepEqual(facts.time, { ok: true, totalHours: 12.5, music: 1.5, code: 8, browser: 2.5 });
    assert.deepEqual(facts.youtube, { subs: 104, views: 5200, videos: 13, subsDelta: 4, viewsDelta: 200, videosDelta: 1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty fixture dir still writes a valid, empty week', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'week-facts-empty-'));
  const out = path.join(dir, 'nested', 'week-facts.json');
  try {
    const line = execFileSync(process.execPath, [TOOL, '--fixture', dir, '--out', out], { cwd: dir, encoding: 'utf8' });
    assert.match(line.trim(), /\(0 commits, 0 agent runs\)$/);
    const facts = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(facts.agents.runs, 0);
    assert.deepEqual(facts.time, { ok: false, reason: 'no activity data' });
    assert.equal(facts.youtube, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool rejects an unknown argument instead of guessing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'week-facts-args-'));
  try {
    assert.throws(() => execFileSync(process.execPath, [TOOL, '--fixture', FIXTURES, '--wat', '1'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }), /Command failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
