'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, canReleaseNow, keepFingerprint, keepLogKind, permanentProofFailure } = require('../lib/orca-reap.cjs');

const NOW = Date.parse('2026-10-29T20:00:00Z');
const STARTED = '2026-10-29T18:00:00Z';
const COMPLETE = '2026-10-29T18:30:00Z';

function fixture(overrides = {}) {
  const result = { provenance: 'worker_report', outcome: 'succeeded', reportPath: 'report.md', filesModified: ['lib/a.cjs'], completedAt: COMPLETE,
    ...(overrides.result || {}) };
  return {
    worker: { workerState: 'succeeded', terminalState: 'reclaimable', resource: { retainedReason: null }, ...(overrides.worker || {}) },
    task: { status: 'completed', created_at: STARTED, result: JSON.stringify(result), ...(overrides.task || {}) },
    now: overrides.now ?? NOW, graceMs: overrides.graceMs ?? 20 * 60 * 1000,
    checks: { report: { exists: true, size: 10, mtimeMs: Date.parse(COMPLETE), dispatchStartedAt: STARTED },
      files: [{ path: 'lib/a.cjs', found: true, gitRepo: true, clean: true }], ...(overrides.checks || {}) }
  };
}

function reasons(input) { return decide(input).reasons; }

test('releases only a fully proven succeeded worker', () => {
  assert.deepEqual(decide(fixture()), { action: 'release', reasons: [] });
});

test('pre-release gate rejects a changed row or outstanding coordinator action', () => {
  const worker = { dispatchId: 'ctx_1', workerState: 'succeeded', terminalState: 'reclaimable', resource: { retainedReason: null },
    projection: { nextAction: { kind: 'release', argv: ['orchestration', 'worker-release', '--dispatch', 'ctx_1'] } } };
  assert.equal(canReleaseNow(worker), true);
  assert.equal(canReleaseNow({ ...worker, terminalState: 'retained' }), false);
  assert.equal(canReleaseNow({ ...worker, projection: { nextAction: { kind: 'wait', argv: [] } } }), false);
});

test('keeps workers that did not succeed and marks terminal failures for review', () => {
  const input = fixture({ worker: { workerState: 'failed' }, result: { outcome: 'failed' } });
  assert.equal(decide(input).action, 'keep');
  assert.ok(reasons(input).includes('needs-review'));
  assert.ok(reasons(input).includes('worker-state:failed'));
});

test('keeps retained workers', () => {
  assert.ok(reasons(fixture({ worker: { resource: { retainedReason: 'user takeover' } } })).includes('retained'));
});

test('keeps a worker inside the grace period', () => {
  assert.ok(reasons(fixture({ now: Date.parse('2026-10-29T18:40:00Z') })).includes('inside-grace'));
});

test('keeps a task with no report path', () => {
  assert.ok(reasons(fixture({ result: { reportPath: null } })).includes('report-path-missing'));
});

test('keeps a missing report', () => {
  assert.ok(reasons(fixture({ checks: { report: { exists: false, size: 0 } } })).includes('report-missing'));
});

test('keeps an empty report', () => {
  assert.ok(reasons(fixture({ checks: { report: { exists: true, size: 0, mtimeMs: NOW, dispatchStartedAt: STARTED } } })).includes('report-empty'));
});

test('keeps a report older than the dispatch beyond clock slack', () => {
  const report = { exists: true, size: 1, mtimeMs: Date.parse('2026-10-29T17:57:59Z'), dispatchStartedAt: STARTED };
  assert.ok(reasons(fixture({ checks: { report } })).includes('report-too-old'));
});

test('keeps a report older than a modified file beyond clock slack', () => {
  const checks = { report: { exists: true, size: 1, mtimeMs: Date.parse('2026-10-29T18:20:00Z'), dispatchStartedAt: STARTED },
    files: [{ path: 'lib/a.cjs', found: true, gitRepo: true, clean: true, mtimeMs: Date.parse('2026-10-29T18:25:00Z') }] };
  assert.ok(reasons(fixture({ checks })).includes('report-older-than-files'));
});

test('ignores edits made after the worker reported done', () => {
  const checks = { report: { exists: true, size: 1, mtimeMs: Date.parse(COMPLETE), dispatchStartedAt: STARTED },
    files: [{ path: 'lib/a.cjs', found: true, gitRepo: true, clean: true, mtimeMs: Date.parse('2026-10-29T19:30:00Z') }] };
  assert.ok(!reasons(fixture({ checks })).includes('report-older-than-files'));
});

test('keeps a dirty modified file', () => {
  const files = [{ path: 'lib/a.cjs', found: true, gitRepo: true, clean: false }];
  assert.ok(reasons(fixture({ checks: { files } })).includes('file-dirty:lib/a.cjs'));
});

test('keeps a modified file that was not found', () => {
  const files = [{ path: 'lib/a.cjs', found: false, gitRepo: false, clean: false }];
  assert.ok(reasons(fixture({ checks: { files } })).includes('file-not-found:lib/a.cjs'));
});

test('keeps a file found under a non-git root', () => {
  const files = [{ path: 'lib/a.cjs', found: true, gitRepo: false, clean: false }];
  assert.ok(reasons(fixture({ checks: { files } })).includes('file-non-git:lib/a.cjs'));
});

test('allows a research task with no modified files', () => {
  const input = fixture({ result: { filesModified: [] }, checks: { files: [] } });
  assert.deepEqual(decide(input), { action: 'release', reasons: [] });
});

test('keep fingerprints sort reasons and change with newest evidence', () => {
  const first = keepFingerprint({ dispatchId: 'ctx', reasons: ['b', 'a'], evidenceMtime: 10 });
  assert.equal(first, keepFingerprint({ dispatchId: 'ctx', reasons: ['a', 'b'], evidenceMtime: 10 }));
  assert.notEqual(first, keepFingerprint({ dispatchId: 'ctx', reasons: ['a', 'b'], evidenceMtime: 11 }));
});

test('unchanged keeps skip until their 24 hour still-blocked line', () => {
  const fingerprint = 'same', at = Date.parse('2026-10-28T20:00:00Z');
  const history = [{ ts: new Date(at).toISOString(), fingerprint }];
  assert.equal(keepLogKind(history, fingerprint, at + 23 * 3600000), 'skip');
  assert.equal(keepLogKind(history, fingerprint, at + 24 * 3600000), 'still-blocked');
});

test('missing and non-git proof failures need a human', () => {
  assert.equal(permanentProofFailure(['file-not-found:a']), true);
  assert.equal(permanentProofFailure(['file-non-git:a']), true);
  assert.equal(permanentProofFailure(['file-dirty:a']), false);
});
