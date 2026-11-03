import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRun, dismissTrashed, emptyLedger, localChecks, parseModelAnswer, previewDiff, reportFileAt, summarizeOutcomes } from '../tools/hq-review-ledger.mjs';

const NOW = Date.parse('2026-10-28T20:00:00Z');
const outcome = (status, at, extra = {}) => ({ source: 'hq', taskType: 'api-hq-review', status, end: Date.parse(at), durationMs: 1000, ...extra });

test('task failure counts include only failures since the task last succeeded', () => {
  const summary = summarizeOutcomes([
    outcome('failed', '2026-10-28T10:00:00Z'),
    outcome('failed', '2026-10-28T11:00:00Z'),
    outcome('succeeded', '2026-10-28T12:00:00Z'),
  ], NOW);
  assert.equal(summary.tasks[0].failed, 0);
  assert.equal(summary.tasks[0].lastStatus, 'succeeded');
  const checks = localChecks(contextWith(summary));
  assert.equal(checks.some(c => c.id === 'task-failing:api-hq-review'), false);
});

test('running outcomes are excluded, including the review executing now', () => {
  const summary = summarizeOutcomes([
    outcome('succeeded', '2026-10-28T12:00:00Z'),
    outcome('running', '2026-10-28T19:59:00Z'),
  ], NOW);
  assert.equal(summary.total, 1);
  assert.equal(summary.tasks[0].runs, 1);
  assert.equal(summary.tasks[0].lastStatus, 'succeeded');
});

test('ledger transitions repeated findings from new to open and trash dismissal hides them', () => {
  const finding = { id: 'meter-high:copilot:credits', title: 'Copilot credits are high', level: 'watch', evidence: '94.7% used' };
  const first = applyRun(emptyLedger(), [finding], { at: '2026-10-28T18:00:00Z', report: 'first.html' });
  assert.equal(first.findings[finding.id].status, 'new');
  const second = applyRun(first, [finding], { at: '2026-10-28T19:00:00Z', report: 'second.html' });
  assert.equal(second.findings[finding.id].status, 'open');
  assert.equal(previewDiff(second, [finding]).open[0].seenCount, 3);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-review-ledger-'));
  fs.writeFileSync(path.join(temp, 'second.html'), 'trashed');
  const dismissed = dismissTrashed(second, temp);
  assert.equal(dismissed.findings[finding.id].status, 'dismissed');
  assert.equal(previewDiff(dismissed, [finding]).dismissed.length, 1);
});

test('reportFileAt predicts the run report name in local time, so trashing that report still dismisses', t => {
  const tz = process.env.TZ; process.env.TZ = 'America/New_York';
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  // 9:30 PM on Nov 1 in New York is already Nov 2 in UTC.
  assert.equal(reportFileAt(new Date('2026-11-02T02:30:00Z')), 'api-hq-review-20261101-2130.html');
});

test('a dismissed watch finding returns open when it escalates to act', () => {
  const watch = { id: 'meter-high:copilot:credits', title: 'Credits high', level: 'watch', evidence: '85% used' };
  const ledger = applyRun(emptyLedger(), [watch], { at: '2026-10-28T18:00:00Z', report: 'first.html' });
  ledger.findings[watch.id].status = 'dismissed';
  const act = { ...watch, level: 'act', evidence: '95% used' };
  assert.equal(previewDiff(ledger, [act]).escalated.length, 1);
  const next = applyRun(ledger, [act], { at: '2026-10-28T19:00:00Z', report: 'second.html' });
  assert.equal(next.findings[watch.id].status, 'open');
  assert.match(next.findings[watch.id].lastEvidence, /escalated/);
});

test('invalid model JSON falls back to deterministic checks', () => {
  const checks = [{ id: 'ram-high', title: 'Memory high', level: 'watch', evidence: '86% used' }];
  const parsed = parseModelAnswer('Report\n```json\nnot-json\n```', checks);
  assert.equal(parsed.valid, false);
  assert.deepEqual(parsed.findings, checks);
  assert.doesNotMatch(parsed.markdown, /not-json/);
});

test('missed routines become stable deterministic review findings', () => {
  const context = contextWith({ byStatus: {}, tasks: [], total: 0 });
  context.routines.missed = [{ id: 'bills-routines-check', name: 'Bills check', source: 'desktop', missed: 4, lastRunAt: '2026-10-23T23:21:56Z' }];
  const finding = localChecks(context).find(c => c.id === 'routine-missed:bills-routines-check');
  assert.equal(finding.level, 'act');
  assert.match(finding.evidence, /4 missed/);
});

function contextWith(summary) {
  return {
    hq: { ok: true, engine: true, workspaceSet: true, runner: 'ready' }, companionsDown: [], appsDown: [], meters: [],
    runs24h: summary, routines: { needsSetup: false }, machine: { disks: [], ramUsedPct: 20, ramTotalGB: 32, leakedTestBrowsers: 0 },
    artifacts: { newestHoursAgo: 1 }, gaps: []
  };
}
