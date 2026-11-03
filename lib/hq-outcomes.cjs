'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readOutcomeLog } = require('./run-outcome.cjs');

const CACHE_MS = 60_000;
const SETTLED = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
let orcaCache = { at: 0, outcomes: [], warning: null };
let pendingOrca = null;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function instant(value, assumeUtc = false) {
  if (value === null || value === undefined || value === '') return null;
  const raw = typeof value === 'number' ? value : String(value).trim();
  const prepared = assumeUtc && typeof raw === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(raw)
    ? raw.replace(' ', 'T') + 'Z' : raw;
  const date = new Date(prepared);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function duration(startedAt, endedAt, explicit) {
  if (Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  if (!startedAt || !endedAt) return null;
  const value = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function status(value) {
  const raw = String(value || '').toLowerCase();
  if (['done', 'completed', 'complete', 'succeeded', 'success', 'passed'].includes(raw)) return 'succeeded';
  if (['failed', 'failure', 'error'].includes(raw)) return 'failed';
  if (['cancelled', 'canceled', 'aborted'].includes(raw)) return 'cancelled';
  if (raw === 'blocked') return 'blocked';
  if (raw === 'needs-action') return 'needs-action';
  if (['running', 'in_progress', 'dispatched', 'ready', 'working'].includes(raw)) return 'running';
  return null;
}

function outcome(fields) {
  return {
    sourceId: text(fields.sourceId),
    source: text(fields.source),
    agent: text(fields.agent),
    model: text(fields.model),
    taskType: text(fields.taskType),
    status: status(fields.status),
    startedAt: fields.startedAt || null,
    endedAt: fields.endedAt || null,
    durationMs: Number.isFinite(fields.durationMs) && fields.durationMs >= 0 ? Math.round(fields.durationMs) : null,
    reportRef: text(fields.reportRef),
    next: text(fields.next),
    key: text(fields.key)
  };
}

function normalizeRun(row) {
  if (!row || typeof row !== 'object') return null;
  const endedAt = instant(row.at);
  const durationMs = Number.isFinite(Number(row.seconds)) && Number(row.seconds) >= 0 ? Number(row.seconds) * 1000 : null;
  const startedAt = endedAt && durationMs !== null ? new Date(Date.parse(endedAt) - durationMs).toISOString() : null;
  const exit = Number.isFinite(Number(row.exit)) ? Number(row.exit) : null;
  return outcome({
    sourceId: row.id && endedAt ? `hq:${row.id}:${endedAt}` : null,
    source: 'hq', agent: row.agent, model: row.model, taskType: row.id,
    status: exit === null ? null : exit === 0 ? 'succeeded' : 'failed',
    startedAt, endedAt, durationMs,
    reportRef: row.report ? path.posix.join('artifacts', String(row.report).replace(/\\/g, '/')) : null
  });
}

function normalizeJob(job) {
  if (!job || typeof job !== 'object') return null;
  const startedAt = instant(job.started), endedAt = instant(job.ended);
  return outcome({
    sourceId: job.jobId ? `hq:${job.jobId}` : null,
    source: 'hq', agent: job.agent, model: job.model, taskType: job.id,
    status: job.status, startedAt, endedAt,
    durationMs: duration(startedAt, endedAt, null),
    reportRef: job.report ? path.posix.join('artifacts', String(job.report).replace(/\\/g, '/')) : null
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function hqOutcomes({ kitDir, jobs = [] }) {
  const runs = readJson(path.join(kitDir, 'data', 'runs.json'), []);
  const normalizedRuns = (Array.isArray(runs) ? runs : []).map(normalizeRun).filter(Boolean);
  const normalizedJobs = (Array.isArray(jobs) ? jobs : []).map(normalizeJob).filter(Boolean).filter(job => {
    if (job.status === 'running') return true;
    return !normalizedRuns.some(run => run.taskType === job.taskType && run.endedAt && job.endedAt && Math.abs(Date.parse(run.endedAt) - Date.parse(job.endedAt)) < 3000);
  });

  const logsDir = path.join(kitDir, 'os-runs');
  let logs = [];
  try { logs = fs.readdirSync(logsDir, { withFileTypes: true }).filter(entry => entry.isFile()); } catch (_) {}
  const historicalLogs = logs.map(entry => {
    const match = /^(.*)-(\d{13})\.log$/i.exec(entry.name);
    if (!match) return null;
    const startedAt = instant(Number(match[2]));
    if (normalizedRuns.some(run => run.taskType === match[1] && run.startedAt && Math.abs(Date.parse(run.startedAt) - Number(match[2])) < 3000)) return null;
    if (normalizedJobs.some(job => job.sourceId === `hq:${match[1]}-${match[2]}`)) return null;
    let endedAt = null;
    try { endedAt = instant(fs.statSync(path.join(logsDir, entry.name)).mtimeMs); } catch (_) {}
    return outcome({
      sourceId: `hq:${match[1]}-${match[2]}`, source: 'hq', agent: null, model: null,
      taskType: match[1], status: null, startedAt, endedAt,
      durationMs: duration(startedAt, endedAt, null), reportRef: path.posix.join('os-runs', entry.name)
    });
  }).filter(Boolean);
  const feed = readOutcomeLog(path.join(kitDir, 'os-runs', 'routine-outcomes.jsonl'));
  const feedOutcomes = feed.records.map(row => outcome({
    sourceId: `outcome:${row.key}:${row.ts}`,
    source: row.source,
    taskType: row.routine,
    status: row.status,
    endedAt: instant(row.ts),
    reportRef: row.report ? (String(row.report).replace(/\\/g, '/').startsWith('artifacts/') ? String(row.report).replace(/\\/g, '/') : path.posix.join('artifacts', String(row.report).replace(/\\/g, '/'))) : null,
    next: row.next,
    key: row.key
  }));
  const unmatchedRuns = normalizedRuns.filter(run => !feedOutcomes.some(feedRow =>
    feedRow.source === 'deck' && feedRow.taskType === run.taskType &&
    ((feedRow.reportRef && run.reportRef && feedRow.reportRef === run.reportRef) ||
      (feedRow.endedAt && run.endedAt && Math.abs(Date.parse(feedRow.endedAt) - Date.parse(run.endedAt)) < 3000))));
  return [...normalizedJobs, ...feedOutcomes, ...unmatchedRuns, ...historicalLogs];
}

function runOrca(args, timeout = 15_000) {
  const command = text(process.env.ORCA_CLI_COMMAND) || 'orca';
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(error);
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (_) { return reject(new Error('Orca returned invalid JSON')); }
      if (!parsed || parsed.ok === false) return reject(new Error(parsed?.error?.message || 'Orca command failed'));
      resolve(parsed.result || {});
    });
  });
}

function parseTaskResult(task) {
  if (!task || typeof task.result !== 'string') return {};
  try { const parsed = JSON.parse(task.result); return parsed && typeof parsed === 'object' ? parsed : {}; }
  catch (_) { return {}; }
}

function normalizeOrcaTask(task, worker) {
  const result = parseTaskResult(task);
  const startedAt = instant(task.created_at, true);
  const endedAt = instant(task.completed_at, true) || instant(result.completedAt, true);
  const provider = worker?.agent || worker?.provider || worker?.projection?.provider;
  const agent = typeof provider === 'string' ? provider : provider && typeof provider === 'object' ? provider.id || provider.name : null;
  const model = worker?.model || worker?.projection?.model || null;
  return outcome({
    sourceId: task.id ? `orca:${task.id}` : null,
    source: 'orca', agent, model,
    taskType: task.task_title || task.display_name,
    status: result.outcome || task.status || worker?.projection?.outcome || worker?.workerState,
    startedAt, endedAt, durationMs: duration(startedAt, endedAt, null),
    reportRef: result.reportPath || null
  });
}

async function fetchOrcaOutcomes() {
  const workerResult = await runOrca(['orchestration', 'worker-list', '--limit', '100', '--json']);
  const workers = Array.isArray(workerResult.workers) ? workerResult.workers : [];
  const settledWorkers = workers.filter(worker => SETTLED.has(status(worker?.projection?.outcome || worker?.workerState || worker?.dispatchStatus)));
  const runIds = [...new Set(settledWorkers.map(worker => text(worker.runId)).filter(Boolean))];
  const taskResults = await Promise.allSettled(runIds.map(runId => runOrca(['orchestration', 'task-list', '--run', runId, '--json'])));
  const tasks = [];
  const warnings = [];
  taskResults.forEach((result, index) => {
    if (result.status === 'rejected') warnings.push(`${runIds[index]}: ${result.reason.message}`);
    else if (Array.isArray(result.value.tasks)) tasks.push(...result.value.tasks);
  });
  const byTask = new Map();
  for (const worker of settledWorkers) {
    const current = byTask.get(worker.taskId);
    const currentEnded = Date.parse(current?.resource?.releaseCompletedAt || '') || 0;
    const nextEnded = Date.parse(worker?.resource?.releaseCompletedAt || '') || 0;
    if (!current || nextEnded >= currentEnded) byTask.set(worker.taskId, worker);
  }
  const outcomes = tasks.filter(task => SETTLED.has(status(parseTaskResult(task).outcome || task.status)))
    .map(task => normalizeOrcaTask(task, byTask.get(task.id))).filter(item => item.sourceId);
  return { outcomes, warning: warnings.length ? warnings.join('; ') : null };
}

async function orcaOutcomes({ fresh = false } = {}) {
  if (!fresh && Date.now() - orcaCache.at < CACHE_MS) return orcaCache;
  if (pendingOrca) return pendingOrca;
  pendingOrca = fetchOrcaOutcomes().then(value => {
    orcaCache = { at: Date.now(), outcomes: value.outcomes, warning: value.warning };
    return orcaCache;
  }).catch(error => {
    const previous = orcaCache.outcomes.length ? orcaCache.outcomes : [];
    orcaCache = { at: Date.now(), outcomes: previous, warning: error.message };
    return orcaCache;
  }).finally(() => { pendingOrca = null; });
  return pendingOrca;
}

async function getOutcomes({ kitDir, jobs = [], fresh = false } = {}) {
  const orca = await orcaOutcomes({ fresh });
  const outcomes = [...hqOutcomes({ kitDir, jobs }), ...orca.outcomes]
    .sort((a, b) => Date.parse(b.endedAt || b.startedAt || 0) - Date.parse(a.endedAt || a.startedAt || 0));
  return {
    generatedAt: new Date().toISOString(),
    outcomes,
    sources: {
      hq: { available: true, outcomeFeedSkipped: readOutcomeLog(path.join(kitDir, 'os-runs', 'routine-outcomes.jsonl')).skipped },
      orca: { available: !orca.warning, cachedAt: orca.at ? new Date(orca.at).toISOString() : null, warning: orca.warning }
    }
  };
}

module.exports = { getOutcomes, hqOutcomes, normalizeRun, normalizeJob, normalizeOrcaTask };
