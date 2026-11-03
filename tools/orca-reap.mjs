#!/usr/bin/env node
// Orca worker reaper: proves reports and committed files are saved, then archives and releases safe sessions.
//   node tools/orca-reap.mjs --dry-run [--run <id>] [--grace <minutes>] [--json]
// Results: one line per non-dry decision in os-runs/orca-reap.jsonl and events in the HQ event inbox
// (POST /local/event, or lib/hq-events.cjs directly when HQ is down).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const RUNS = path.join(ROOT, 'os-runs');
const LOG = path.join(RUNS, 'orca-reap.jsonl');
const QUEUE = path.join(RUNS, 'orca-reap-queue.json');
const HQ = 'http://localhost:50000';
const PLACES = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'places.cjs'));
const ORCA_CWD = process.env.ORCA_REAP_CWD || PLACES.orcaWorktree;
const PROJECTS = path.join(os.homedir(), 'Projects');
const STATIC_ROOTS = [ROOT, PLACES.workbench, path.join(PROJECTS, 'agent-hq'), PLACES.companions];
const REVIEW_STATES = new Set(['failed', 'stopped', 'abandoned']);
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const require = createRequire(import.meta.url);
const { decide, canReleaseNow, keepFingerprint, keepLogKind, permanentProofFailure } = require(path.join(ROOT, 'lib', 'orca-reap.cjs'));

function argumentsFrom(argv) {
  const options = { dryRun: false, json: false, run: null, graceMs: 20 * 60 * 1000 };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--dry-run') options.dryRun = true;
    else if (value === '--json') options.json = true;
    else if (value === '--run') options.run = argv[++i];
    else if (value === '--grace') {
      const minutes = Number(argv[++i]);
      if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--grace must be a non-negative number of minutes');
      options.graceMs = minutes * 60 * 1000;
    } else throw new Error(`unknown argument: ${value}`);
  }
  if (options.run === undefined) throw new Error('--run requires an id');
  return options;
}

function resultOf(payload) {
  if (!payload?.ok) throw new Error(payload?.error?.message || payload?.error || 'Orca command failed');
  return payload.result || {};
}

async function command(args) {
  const { stdout } = await exec('orca', [...args, '--json'], {
    cwd: ORCA_CWD, encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024
  });
  return resultOf(JSON.parse(stdout));
}

function orcaIsDown(error) {
  const text = `${error?.message || error} ${error?.stdout || ''} ${error?.stderr || ''}`;
  return /orca (?:is )?not running|runtime.*(?:unavailable|not running)|connect(?:ion)? (?:refused|failed)|ECONNREFUSED/i.test(text);
}

function taskResult(task) {
  if (task?.result && typeof task.result === 'object') return task.result;
  try { return JSON.parse(task?.result || '{}'); } catch (_) { return {}; }
}

function worktreeRoot(worker) {
  const value = worker?.resource?.worktreeId;
  if (!value) return null;
  const marker = value.indexOf('::');
  return path.resolve(marker >= 0 ? value.slice(marker + 2) : value);
}

function uniqueRoots(worker) {
  return [worktreeRoot(worker), ...STATIC_ROOTS].filter(Boolean).filter((value, index, all) =>
    all.findIndex(other => path.resolve(other).toLowerCase() === path.resolve(value).toLowerCase()) === index);
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function reportCheck(task, result) {
  const reportPath = result.reportPath;
  if (!reportPath) return { exists: false, size: 0, mtimeMs: NaN, dispatchStartedAt: task.created_at };
  try {
    const stat = await fs.promises.stat(reportPath);
    return { exists: stat.isFile(), size: stat.size, mtimeMs: stat.mtimeMs, dispatchStartedAt: task.created_at };
  } catch (_) {
    return { exists: false, size: 0, mtimeMs: NaN, dispatchStartedAt: task.created_at };
  }
}

async function gitCheck(root, absolute) {
  try {
    const { stdout } = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024
    });
    const repo = stdout.trim();
    const relative = path.relative(repo, absolute);
    if (!repo || relative.startsWith('..') || path.isAbsolute(relative)) return { gitRepo: false, clean: false };
    const status = await exec('git', ['-C', repo, 'status', '--porcelain', '--', relative], {
      encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024
    });
    return { gitRepo: true, clean: status.stdout.trim() === '' };
  } catch (_) {
    return { gitRepo: false, clean: false };
  }
}

async function fileChecks(worker, files) {
  const roots = uniqueRoots(worker);
  return Promise.all(files.map(async file => {
    for (const root of roots) {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
      if (!inside(root, absolute)) continue;
      try {
        if (!fs.statSync(absolute).isFile()) continue;
      } catch (_) { continue; }
      const stat = fs.statSync(absolute);
      return { path: file, found: true, root, mtimeMs: stat.mtimeMs, ...await gitCheck(root, absolute) };
    }
    return { path: file, found: false, gitRepo: false, clean: false };
  }));
}

function auditGates(worker, task, result, checks, choice, changedBeforeRelease = false) {
  return {
    workerSucceeded: worker.workerState === 'succeeded',
    terminalReclaimable: worker.terminalState === 'reclaimable',
    notRetained: !worker.resource?.retainedReason,
    taskCompleted: task.status === 'completed',
    workerReportSucceeded: result.provenance === 'worker_report' && result.outcome === 'succeeded',
    graceElapsed: !choice.reasons.includes('inside-grace') && !choice.reasons.includes('completed-at-invalid'),
    reportVerified: !choice.reasons.some(reason => ['report-path-missing', 'report-missing', 'report-empty', 'report-too-old'].includes(reason)),
    reportAfterFiles: !choice.reasons.includes('report-older-than-files'),
    filesVerified: !choice.reasons.some(reason => reason.startsWith('file-')),
    unchangedBeforeRelease: !changedBeforeRelease
  };
}

async function transcriptReadable(dispatchId) {
  try {
    const read = await command(['orchestration', 'worker-read', '--dispatch', dispatchId, '--limit', '1']);
    return Array.isArray(read.transcript?.messages) && read.transcript.messages.length > 0;
  } catch (_) { return false; }
}

async function emitEvent(event) {
  const body = JSON.stringify({ source: 'orca-reap', ...event });
  try {
    const response = await fetch(`${HQ}/local/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(4000) });
    if (response.ok) return;
  } catch (_) { }
  try { require(path.join(ROOT, 'lib', 'hq-events.cjs')).append({ source: 'orca-reap', ...event }, { dedupeWindowMs: event.dedupeWindowMs }); } catch (_) { }
}

function appendDecision(row) {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n', 'utf8');
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function logHistory() {
  try { return fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); } catch { return []; }
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, file);
}

async function runsToVisit(options) {
  if (options.run) return [{ id: options.run }];
  const cutoff = Date.now() - FOURTEEN_DAYS_MS;
  const result = await command(['orchestration', 'run-list', '--limit', '100']);
  return (result.runs || []).filter(run => Date.parse(run.updated_at) >= cutoff);
}

function printRows(rows, json) {
  if (json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No reclaimable workers found.');
  console.table(rows.map(row => ({ run: row.runId, dispatch: row.dispatchId, task: row.taskId,
    outcome: row.outcome, decision: row.decision, reasons: row.reasons.join(', ') || '-' })));
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  let runs;
  try { runs = await runsToVisit(options); }
  catch (error) {
    if (orcaIsDown(error)) { console.log('Orca not running; nothing to do'); return; }
    console.error(`Could not list Orca runs: ${error.message || error}`); return;
  }

  const output = [];
  const queue = [];
  const previousQueue = readJson(QUEUE, { items: [] });
  const history = logHistory();
  let releaseFailed = false;
  for (const run of runs) {
    let workers, tasks;
    try {
      [workers, tasks] = await Promise.all([
        command(['orchestration', 'worker-list', '--run', run.id, '--limit', '100']),
        command(['orchestration', 'task-list', '--run', run.id])
      ]);
    } catch (error) {
      console.error(`Could not inspect ${run.id}: ${error.message || error}`);
      continue;
    }
    const taskById = new Map((tasks.tasks || []).map(task => [task.id, task]));
    let reviewCount = 0;
    for (const worker of workers.workers || []) {
      if (worker.terminalState !== 'reclaimable') continue;
      const task = taskById.get(worker.taskId) || {};
      const result = taskResult(task);
      const checks = { report: await reportCheck(task, result), files: await fileChecks(worker, Array.isArray(result.filesModified) ? result.filesModified : []) };
      const choice = decide({ worker, task, now: Date.now(), graceMs: options.graceMs, checks });
      const needsReview = choice.reasons.includes('needs-review') || REVIEW_STATES.has(worker.workerState);
      if (needsReview) reviewCount++;
      let archiveStatus = worker.resource?.archive?.status || null;
      let decision = needsReview ? 'needs-review' : choice.action;
      const reasons = [...choice.reasons];
      let changedBeforeRelease = false;
      let transcriptWasReadable = null;

      if (choice.action === 'release' && !options.dryRun) {
        try {
          const beforeRows = await command(['orchestration', 'worker-list', '--run', run.id, '--limit', '100']);
          const before = (beforeRows.workers || []).find(item => item.dispatchId === worker.dispatchId);
          if (!before || !canReleaseNow(before)) {
            changedBeforeRelease = true;
            decision = 'keep';
            reasons.push('changed-before-release');
          } else {
          await command(['orchestration', 'worker-release', '--dispatch', worker.dispatchId]);
          const refreshed = await command(['orchestration', 'worker-list', '--run', run.id, '--limit', '100']);
          const after = (refreshed.workers || []).find(item => item.dispatchId === worker.dispatchId);
          archiveStatus = after?.resource?.archive?.status || null;
          transcriptWasReadable = await transcriptReadable(worker.dispatchId);
          if (after?.terminalState !== 'released' || archiveStatus !== 'captured' || !transcriptWasReadable) {
            releaseFailed = true;
            decision = 'archive-missing';
            reasons.push(`release-verification:${after?.terminalState || 'missing'}/${archiveStatus || 'missing'}/transcript:${transcriptWasReadable}`);
          }
          await emitEvent({ type: 'orca.worker.released', severity: 'info', key: `orca.worker.released:${worker.dispatchId}`,
            summary: `Released archived Orca worker ${worker.dispatchId}`, data: { runId: run.id, dispatchId: worker.dispatchId, taskId: worker.taskId, archiveStatus } });
          if (archiveStatus !== 'captured' || !transcriptWasReadable) await emitEvent({ type: 'orca.worker.archive-missing', severity: 'warn', key: `orca.worker.archive-missing:${worker.dispatchId}`,
            summary: `Orca worker ${worker.dispatchId} release is missing durable transcript proof`, data: { runId: run.id, dispatchId: worker.dispatchId, taskId: worker.taskId, archiveStatus, transcriptReadable: transcriptWasReadable } });
          }
        } catch (error) {
          releaseFailed = true;
          reasons.push(`release-failed:${String(error.message || error).slice(0, 200)}`);
        }
      }

      const row = { ts: new Date().toISOString(), runId: run.id, dispatchId: worker.dispatchId, taskId: worker.taskId,
        title: String(task.task_title || task.display_name || task.spec || '').slice(0, 80), outcome: result.outcome || worker.workerState || null,
        reportPath: result.reportPath || null, filesModified: Array.isArray(result.filesModified) ? result.filesModified.length : 0,
        decision, reasons, gates: auditGates(worker, task, result, checks, choice, changedBeforeRelease),
        timestamps: { completedAt: result.completedAt || task.completed_at || null, dispatchStartedAt: task.created_at || null,
          reportMtime: Number.isFinite(checks.report.mtimeMs) ? new Date(checks.report.mtimeMs).toISOString() : null, now: new Date().toISOString() },
        archiveStatus, transcriptReadable: transcriptWasReadable };
      if (choice.action === 'keep') {
        if (permanentProofFailure(reasons)) { decision = 'needs-human'; row.decision = decision; }
        // Only a rewritten report is new evidence; file state already shows in the reasons, and other sessions' edits
        // to the same files would otherwise change the fingerprint every run.
        const evidenceMtime = Number(checks.report.mtimeMs) || 0;
        row.fingerprint = keepFingerprint({ dispatchId: worker.dispatchId, reasons, evidenceMtime });
        const previous = (previousQueue.items || []).find(item => item.fingerprint === row.fingerprint);
        queue.push({ run: run.id, dispatch: worker.dispatchId, task: worker.taskId, reasons, since: previous?.since || row.ts, fingerprint: row.fingerprint });
      }
      output.push(row);
      if (!options.dryRun) {
        if (choice.action !== 'keep') appendDecision(row);
        else {
          const kind = keepLogKind(history, row.fingerprint, Date.parse(row.ts));
          if (kind !== 'skip') {
            if (kind === 'still-blocked') row.decision = 'still-blocked';
            appendDecision(row);
            history.push(row);
          }
          if (kind === 'new') await emitEvent({ type: 'orca.keep.new', severity: decision === 'needs-human' ? 'warn' : 'info', key: `orca.keep.new:${row.fingerprint}`,
            summary: `Orca worker ${worker.dispatchId} has a new cleanup blocker`, data: { runId: run.id, dispatchId: worker.dispatchId, taskId: worker.taskId, reasons, fingerprint: row.fingerprint } });
        }
      }
    }
    if (reviewCount && !options.dryRun) await emitEvent({ type: 'orca.reap.needs-review', severity: 'info', key: `orca.reap.needs-review:${run.id}`,
      dedupeWindowMs: FOURTEEN_DAYS_MS, summary: `${reviewCount} Orca worker${reviewCount === 1 ? '' : 's'} in ${run.id} need review`, data: { runId: run.id, count: reviewCount } });
  }
  if (!options.dryRun) atomicJson(QUEUE, { generated: new Date().toISOString(), items: queue });
  printRows(output, options.json);
  if (releaseFailed) process.exitCode = 1;
}

main().catch(error => { console.error(error.message || error); });
