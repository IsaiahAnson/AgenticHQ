'use strict';

const crypto = require('node:crypto');

// Orca reap policy: pure, conservative proof checks for releasing a completed worker session.

const DEFAULT_GRACE_MS = 20 * 60 * 1000;
const CLOCK_SLACK_MS = 2 * 60 * 1000;
const REVIEW_STATES = new Set(['failed', 'stopped', 'abandoned']);

function parseResult(task) {
  if (task?.result && typeof task.result === 'object') return task.result;
  try { return JSON.parse(task?.result || '{}'); } catch (_) { return {}; }
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const normalized = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  return Date.parse(normalized);
}

function canReleaseNow(worker = {}) {
  const next = worker.projection?.nextAction;
  const releaseAction = next?.kind === 'release' && Array.isArray(next.argv)
    && next.argv.includes('worker-release') && next.argv.includes(worker.dispatchId);
  return worker.workerState === 'succeeded' && worker.terminalState === 'reclaimable'
    && !worker.resource?.retainedReason && releaseAction;
}

function decide({ worker = {}, task = {}, now = Date.now(), graceMs = DEFAULT_GRACE_MS, checks = {} } = {}) {
  const reasons = [];
  const result = parseResult(task);
  const state = String(worker.workerState || 'unknown');

  if (REVIEW_STATES.has(state)) reasons.push('needs-review');
  if (state !== 'succeeded') reasons.push(`worker-state:${state}`);
  if (worker.terminalState !== 'reclaimable') reasons.push(`terminal-state:${worker.terminalState || 'unknown'}`);
  if (worker.resource?.retainedReason) reasons.push('retained');
  if (task.status !== 'completed') reasons.push(`task-status:${task.status || 'unknown'}`);
  if (result.provenance !== 'worker_report') reasons.push('result-not-worker-report');
  if (result.outcome !== 'succeeded') reasons.push(`outcome:${result.outcome || 'unknown'}`);

  const completedAt = timestamp(result.completedAt || task.completed_at);
  const currentTime = timestamp(now);
  const grace = Number.isFinite(Number(graceMs)) ? Math.max(0, Number(graceMs)) : DEFAULT_GRACE_MS;
  if (!Number.isFinite(completedAt)) reasons.push('completed-at-invalid');
  else if (!Number.isFinite(currentTime) || currentTime - completedAt < grace) reasons.push('inside-grace');

  const report = checks.report || {};
  if (!result.reportPath) reasons.push('report-path-missing');
  else {
    if (!report.exists) reasons.push('report-missing');
    else if (!(Number(report.size) > 0)) reasons.push('report-empty');
    const startedAt = timestamp(report.dispatchStartedAt ?? worker.startedAt ?? task.created_at);
    const mtime = timestamp(report.mtimeMs);
    if (report.exists && Number(report.size) > 0 && (!Number.isFinite(startedAt) || !Number.isFinite(mtime) || mtime + CLOCK_SLACK_MS < startedAt)) {
      reasons.push('report-too-old');
    }
  }

  const files = Array.isArray(checks.files) ? checks.files : [];
  const expectedFiles = Array.isArray(result.filesModified) ? result.filesModified : [];
  if (files.length < expectedFiles.length) reasons.push('file-check-missing');
  for (const file of files) {
    const label = file.path ? `:${file.path}` : '';
    if (!file.found) reasons.push(`file-not-found${label}`);
    else if (!file.gitRepo) reasons.push(`file-non-git${label}`);
    else if (!file.clean) reasons.push(`file-dirty${label}`);
  }
  // Edits after this worker reported done belong to later work, so they can't make its report stale.
  const ownEdit = file => !Number.isFinite(completedAt) || Number(file.mtimeMs) <= completedAt + CLOCK_SLACK_MS;
  const newestFileMtime = Math.max(...files.filter(file => file.found && Number.isFinite(Number(file.mtimeMs)) && ownEdit(file)).map(file => Number(file.mtimeMs)), -Infinity);
  const reportMtime = timestamp(report.mtimeMs);
  if (Number.isFinite(newestFileMtime) && (!Number.isFinite(reportMtime) || reportMtime + CLOCK_SLACK_MS < newestFileMtime)) {
    reasons.push('report-older-than-files');
  }

  return reasons.length ? { action: 'keep', reasons } : { action: 'release', reasons: [] };
}

function keepFingerprint({ dispatchId, reasons = [], evidenceMtime = null } = {}) {
  const payload = [String(dispatchId || ''), [...new Set(reasons.map(String))].sort(), Number.isFinite(Number(evidenceMtime)) ? Number(evidenceMtime) : null];
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 20);
}

function permanentProofFailure(reasons = []) {
  return reasons.some(reason => /^file-(?:not-found|non-git)(?::|$)/.test(reason));
}

function keepLogKind(history, fingerprint, now = Date.now()) {
  const matches = (Array.isArray(history) ? history : []).filter(row => row.fingerprint === fingerprint);
  if (!matches.length) return 'new';
  const latest = Math.max(...matches.map(row => Date.parse(row.ts || '')).filter(Number.isFinite), -Infinity);
  return Number(now) - latest >= 24 * 60 * 60 * 1000 ? 'still-blocked' : 'skip';
}

module.exports = { decide, canReleaseNow, keepFingerprint, keepLogKind, permanentProofFailure, DEFAULT_GRACE_MS, CLOCK_SLACK_MS };
