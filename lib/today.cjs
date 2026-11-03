'use strict';

const fs = require('fs');
const path = require('path');

const DAY = 864e5;
const STATES = ['No response', 'Waiting', 'Interview', 'Action needed', 'Rejected', 'Closed'];

function readTail(file, maxBytes = 200 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch (_) { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

function nextActions(text, { now = Date.now(), limit = 5 } = {}) {
  const newest = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch (_) { continue; }
    const routine = String(row.routine || '').trim(), action = String(row.next || '').trim().replace(/^next action:\s*/i, ''), ts = Date.parse(row.ts || '');
    if (!routine || !action || !Number.isFinite(ts) || ts > now || ts < now - DAY) continue;
    const prior = newest.get(routine);
    if (!prior || ts > prior.time) newest.set(routine, { routine, text: action, ts: new Date(ts).toISOString(), time: ts });
  }
  return [...newest.values()].sort((a, b) => b.time - a.time).slice(0, limit).map(({ time, ...row }) => row);
}

function jobSummary(rows, { now = Date.now(), weeklyGoal = 10, fileTime = null } = {}) {
  if (!Array.isArray(rows)) throw new Error('bad tracker');
  const byState = Object.fromEntries(STATES.map(state => [state, 0]));
  let followUpsDue = 0, appliedLast7 = 0, lastApplied = null;
  const today = new Date(now).toISOString().slice(0, 10);
  const floor = new Date(Date.parse(today + 'T00:00:00Z') - 6 * DAY).toISOString().slice(0, 10);
  for (const row of rows) {
    if (Object.hasOwn(byState, row?.state)) byState[row.state]++;
    if (row?.followUpDue === true) followUpsDue++;
    const applied = /^\d{4}-\d{2}-\d{2}$/.test(String(row?.applied || '')) ? row.applied : null;
    if (applied && applied >= floor && applied <= today) appliedLast7++;
    if (applied && (!lastApplied || applied > lastApplied)) lastApplied = applied;
  }
  return { total: rows.length, byState, followUpsDue, appliedLast7, weeklyGoal: Number(weeklyGoal) || 10, lastApplied, fileTime };
}

function getToday({ kit, applicationsFile, weeklyGoal = 10, now = Date.now() } = {}) {
  const outcomes = readTail(path.join(kit, 'os-runs', 'routine-outcomes.jsonl'));
  const next = nextActions(outcomes, { now });
  if (!applicationsFile) return { next };   /* no tracker set up in os-config.json "today": the Jobs row hides */
  let jobs;
  try {
    const stat = fs.statSync(applicationsFile);
    const rows = JSON.parse(fs.readFileSync(applicationsFile, 'utf8').replace(/^\uFEFF/, ''));
    jobs = jobSummary(rows, { now, weeklyGoal, fileTime: stat.mtime.toISOString() });
  } catch (_) { jobs = { error: 'no tracker' }; }
  return { next, jobs };
}

module.exports = { STATES, readTail, nextActions, jobSummary, getToday };
