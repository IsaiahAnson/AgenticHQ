'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMATTERS = new Map();

function formatter(timeZone) {
  if (!FORMATTERS.has(timeZone)) FORMATTERS.set(timeZone, new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }));
  return FORMATTERS.get(timeZone);
}

function zonedParts(ms, timeZone) {
  const values = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    year: Number(values.year), month: Number(values.month), dom: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute),
    dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday)
  };
}

function field(expr, value, min, max) {
  const names = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const valueExpr = String(expr).toLowerCase().replace(/[a-z]{3}/g, token => names[token] ?? token);
  return valueExpr.split(',').some(part => {
    let [base, step] = part.split('/');
    step = step ? Number(step) : 1;
    if (!Number.isInteger(step) || step <= 0) return false;
    let low, high;
    if (base === '*' || base === '?') { low = min; high = max; }
    else if (base.includes('-')) [low, high] = base.split('-').map(Number);
    else { low = Number(base); high = step > 1 ? max : low; }
    if (max === 6) { if (low === 7) low = 0; if (high === 7) high = 6; }
    return Number.isFinite(low) && Number.isFinite(high) && value >= low && value <= high && (value - low) % step === 0;
  });
}

function cronMatches(expr, ms, timeZone = 'America/New_York') {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const p = zonedParts(ms, timeZone);
  const anyDom = /^[*?]$/.test(fields[2]), anyDow = /^[*?]$/.test(fields[4]);
  const dom = field(fields[2], p.dom, 1, 31), dow = field(fields[4], p.dow, 0, 6);
  return field(fields[0], p.minute, 0, 59) && field(fields[1], p.hour, 0, 23) && field(fields[3], p.month, 1, 12)
    && (anyDom && anyDow ? true : anyDom ? dow : anyDow ? dom : dom || dow);
}

function expectedFires({ cron, from, to, timeZone = 'America/New_York' }) {
  const out = [];
  let cursor = Math.floor(Number(from) / 60000) * 60000 + 60000;
  const end = Math.floor(Number(to) / 60000) * 60000;
  for (; cursor <= end; cursor += 60000) if (cronMatches(cron, cursor, timeZone)) out.push(cursor);
  return out;
}

function time(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function windowsTaskResult(value) {
  const code = Number(value);
  return { never: code === 267011, running: code === 267009, failed: ![0, 267009, 267011].includes(code) };
}

function missedCron({ cron, lastRunAt, createdAt, now = Date.now(), graceMs = 2 * 3600000, timeZone = 'America/New_York', maxLookbackDays = 90, respectCreatedAt = false } = {}) {
  const cutoff = Number(now) - graceMs;
  const lastRun = time(lastRunAt), created = time(createdAt);
  const lookback = cutoff - maxLookbackDays * 86400000;
  const countFrom = Math.max(lastRun || created || lookback, lookback, respectCreatedAt && created ? created : -Infinity);
  const recentFrom = Math.max(lookback, cutoff - 8 * 86400000, respectCreatedAt && created ? created - 60000 : -Infinity);
  const recent = expectedFires({ cron, from: recentFrom, to: cutoff, timeZone });
  const lastExpected = recent.at(-1) || null;
  if (!lastExpected || (lastRun && lastRun >= lastExpected)) return { missed: 0, lastExpected, lastRunAt: lastRun };
  if (!lastRun && created && created > lastExpected) {
    const insideGrace = expectedFires({ cron, from: cutoff, to: now, timeZone });
    if (insideGrace.length) return { missed: 0, lastExpected, lastRunAt: null };
  }
  const fires = expectedFires({ cron, from: countFrom, to: cutoff, timeZone });
  return { missed: Math.max(1, fires.length), lastExpected, lastRunAt: lastRun };
}

function sentinelFingerprint(line) {
  return crypto.createHash('sha256').update(JSON.stringify({ ok: !!line.ok, results: line.results || null })).digest('hex').slice(0, 16);
}

function sentinelLogRows(existing, line, now = Date.now()) {
  const cutoff = Number(now) - 30 * 86400000;
  const day = new Date(now).toISOString().slice(0, 10);
  const rows = (Array.isArray(existing) ? existing : []).filter(row => {
    const at = row.kind === 'rollup' ? Date.parse(`${row.day}T23:59:59.999Z`) : Date.parse(row.ts || '');
    return Number.isFinite(at) && at >= cutoff;
  });
  const rollup = rows.find(row => row.kind === 'rollup' && row.mode === line.mode && row.day === day);
  if (rollup) {
    rollup.runs = Number(rollup.runs || 0) + 1;
    rollup.ok = Number(rollup.ok || 0) + (line.ok ? 1 : 0);
    rollup.failed = Number(rollup.failed || 0) + (line.ok ? 0 : 1);
  } else rows.push({ kind: 'rollup', mode: line.mode, day, runs: 1, ok: line.ok ? 1 : 0, failed: line.ok ? 0 : 1 });
  const fingerprint = sentinelFingerprint(line);
  const previous = rows.filter(row => row.kind !== 'rollup' && row.mode === line.mode).at(-1);
  const previousFingerprint = previous?.fingerprint || (previous ? sentinelFingerprint(previous) : null);
  if (fingerprint !== previousFingerprint) rows.push({ ...line, fingerprint });
  return rows;
}

function writeSentinelLog(file, line, { now = Date.now() } = {}) {
  let existing = [];
  try { existing = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(row => JSON.parse(row)); } catch (_) { existing = []; }
  const rows = sentinelLogRows(existing, line, now);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  fs.renameSync(temporary, file);
  return rows;
}

module.exports = { cronMatches, expectedFires, missedCron, sentinelFingerprint, sentinelLogRows, windowsTaskResult, writeSentinelLog, zonedParts };
