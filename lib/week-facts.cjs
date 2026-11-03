'use strict';
/* Week in HQ facts (P6): pure numbers from the week's agent runs, routines, ring pages, radar runs,
   commits, screen time and YouTube rows. Window is [now - days, now): a row stamped exactly at the start
   counts, one stamped at now does not. Every reader skips malformed rows instead of throwing, so a
   half-written log still produces a page. No file reads and no model calls here; tools/week-in-hq.mjs
   gathers the inputs. Tested in test/week-facts.test.cjs. */
const DAY = 864e5;

const AGENT_STATUSES = new Set(['succeeded', 'failed', 'needs-action']);
const ROUTINE_STATUSES = new Set(['healthy', 'needs-action']);
const VERDICTS = ['adopt', 'trial', 'watch', 'skip'];
const DECISIONS = ['implement', 'later', 'dismiss'];
/* the live agent-floor page is refreshed constantly; it says nothing about what was read */
const SKIP_ARTIFACT = 'agent-monitor.html';

const round1 = value => Number(Number(value || 0).toFixed(1));
const isoOf = ms => new Date(ms).toISOString();
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : null;
}

const countOf = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const listOf = value => (Array.isArray(value) ? value : []);
const textOf = value => (typeof value === 'string' && value.trim() ? value.trim() : '');
/* opens and sidecars name files; compare on the bare name */
const fileOf = value => String(value || '').replace(/\\/g, '/').split('/').pop();

const rowsIn = (rows, key, from, to) => {
  const kept = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const at = timeOf(row[key]);
    if (at === null || at < from || at >= to) continue;
    kept.push({ row, at });
  }
  return kept;
};

/* agent runs: counts, hours actually spent, per-agent spread and the busiest day */
function agentFacts(rows, from, to) {
  const runs = [];
  for (const row of listOf(rows)) {
    if (!row || typeof row !== 'object') continue;
    if (!AGENT_STATUSES.has(row.status)) continue;
    const at = timeOf(row.endedAt);
    const started = at === null ? timeOf(row.startedAt) : null;
    const stamp = at === null ? started : at;
    if (stamp === null || stamp < from || stamp >= to) continue;
    runs.push({ row, at: stamp });
  }
  const byAgent = {};
  const byDay = new Map();
  let millis = 0;
  let succeeded = 0;
  let failed = 0;
  let needsAction = 0;
  for (const { row, at } of runs) {
    const agent = textOf(row.agent);
    if (agent) byAgent[agent] = (byAgent[agent] || 0) + 1;
    if (row.status === 'succeeded') succeeded += 1;
    else if (row.status === 'failed') failed += 1;
    else needsAction += 1;
    millis += countOf(row.durationMs);
    const day = dayOf(at);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  let busiestDay = null;
  for (const day of [...byDay.keys()].sort()) {
    if (busiestDay === null || byDay.get(day) > byDay.get(busiestDay)) busiestDay = day;
  }
  return { runs: runs.length, succeeded, failed, needsAction, hours: round1(millis / 3600000), byAgent, busiestDay };
}

/* routine outcomes: the footguns are the routines that keep asking for a human */
function automationFacts(rows, from, to) {
  const needs = new Map();
  let runs = 0;
  let healthy = 0;
  let needsAction = 0;
  for (const { row } of rowsIn(listOf(rows), 'ts', from, to)) {
    if (!ROUTINE_STATUSES.has(row.status)) continue;
    const routine = textOf(row.routine);
    if (!routine) continue;
    runs += 1;
    if (row.status === 'healthy') healthy += 1;
    else {
      needsAction += 1;
      needs.set(routine, (needs.get(routine) || 0) + 1);
    }
  }
  const topNeedsAction = [...needs.entries()]
    .map(([routine, count]) => ({ routine, count }))
    .sort((a, b) => b.count - a.count || a.routine.localeCompare(b.routine))
    .slice(0, 3);
  return { runs, healthy, needsAction, topNeedsAction };
}

/* ring: pages written this week and whether anyone opened them */
function ringFacts(artifacts, opens, from, to) {
  const created = [];
  for (const { row, at } of rowsIn(listOf(artifacts), 'created', from, to)) {
    const file = fileOf(row.file);
    if (!file || file === SKIP_ARTIFACT) continue;
    created.push({ file, title: textOf(row.title) || file, at });
  }
  const everOpened = new Set();
  const openedInWindow = new Set();
  for (const row of listOf(opens)) {
    if (!row || typeof row !== 'object') continue;
    const file = fileOf(row.file);
    if (!file || file === SKIP_ARTIFACT) continue;
    everOpened.add(file);
    const at = timeOf(row.ts);
    if (at !== null && at >= from && at < to) openedInWindow.add(file);
  }
  const notOpened = created
    .filter(item => !everOpened.has(item.file))
    .sort((a, b) => b.at - a.at || a.title.localeCompare(b.title))
    .slice(0, 5)
    .map(item => item.title);
  return { created: created.length, opened: openedInWindow.size, notOpened };
}

/* radar: what the scans found and what got decided about it */
function radarFacts(runs, decisions, from, to) {
  const byVerdict = { adopt: 0, trial: 0, watch: 0, skip: 0 };
  const inWindow = rowsIn(listOf(runs).map(r => (r && typeof r === 'object' && !r.generatedAt ? { ...r, generatedAt: r.finishedAt || r.startedAt } : r)), 'generatedAt', from, to).sort((a, b) => b.at - a.at);
  let findings = 0;
  const top = [];
  for (const { row } of inWindow) {
    for (const finding of listOf(row.findings)) {
      if (!finding || typeof finding !== 'object') continue;
      const verdict = textOf(finding.verdict).toLowerCase();
      if (!VERDICTS.includes(verdict)) continue;
      findings += 1;
      byVerdict[verdict] += 1;
      const title = textOf(finding.title);
      if ((verdict === 'adopt' || verdict === 'trial') && title && top.length < 3) top.push(title);
    }
  }
  const counted = { implement: 0, later: 0, dismiss: 0 };
  const items = decisions && typeof decisions === 'object' ? decisions.items : null;
  if (items && typeof items === 'object') {
    for (const value of Object.values(items)) {
      if (!value || typeof value !== 'object') continue;
      const at = timeOf(value.at);
      if (at === null || at < from || at >= to) continue;
      const decision = textOf(value.decision).toLowerCase();
      if (DECISIONS.includes(decision)) counted[decision] += 1;
    }
  }
  return { runs: inWindow.length, findings, byVerdict, top, decisions: counted };
}

/* shipping: commits per repo, per day, and the longest unbroken run of days */
function shippingFacts(records, from, to) {
  const byDay = {};
  const repos = new Map();
  let commits = 0;
  for (const record of listOf(records)) {
    if (!record || typeof record !== 'object') continue;
    const repo = textOf(record.repo);
    if (!repo) continue;
    for (const commit of listOf(record.commits)) {
      if (!commit || typeof commit !== 'object') continue;
      const at = timeOf(commit.date);
      if (at === null || at < from || at >= to) continue;
      const day = dayOf(at);
      commits += 1;
      byDay[day] = (byDay[day] || 0) + 1;
      const row = repos.get(repo) || { repo, commits: 0, insertions: 0, deletions: 0 };
      row.commits += 1;
      row.insertions += countOf(commit.insertions);
      row.deletions += countOf(commit.deletions);
      repos.set(repo, row);
    }
  }
  const days = Object.keys(byDay).sort();
  let longest = 0;
  let streak = 0;
  let previous = null;
  for (const day of days) {
    const at = Date.parse(`${day}T00:00:00.000Z`);
    streak = previous !== null && at - previous === DAY ? streak + 1 : 1;
    previous = at;
    if (streak > longest) longest = streak;
  }
  return {
    commits,
    repos: [...repos.values()].sort((a, b) => b.commits - a.commits || a.repo.localeCompare(b.repo)),
    byDay,
    longestStreakDays: longest
  };
}

/* screen time: an ActivityWatch failure is a fact to report, not a reason to drop the page */
function timeFacts(activity) {
  if (!activity || typeof activity !== 'object' || activity.ok !== true) {
    const reason = activity && typeof activity === 'object' ? textOf(activity.reason) : '';
    return { ok: false, reason: reason || 'no activity data' };
  }
  const by = activity.byCategory && typeof activity.byCategory === 'object' ? activity.byCategory : {};
  const hours = value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(Number(value).toFixed(1)) : 0);
  return {
    ok: true,
    totalHours: hours(activity.totalHours),
    music: hours(by.music),
    code: hours(by.code),
    browser: hours(by.browser)
  };
}

/* YouTube: newest row in the week against the newest row from before it */
function youtubeFacts(rows, from, to) {
  const list = [];
  for (const row of listOf(rows)) {
    if (!row || typeof row !== 'object') continue;
    const at = timeOf(row.ts);
    if (at === null) continue;
    list.push({ row, at });
  }
  if (!list.length) return null;
  list.sort((a, b) => a.at - b.at);
  const current = [...list].reverse().find(item => item.at < to);
  if (!current) return null;
  const earlier = list.filter(item => item.at <= from).pop() || null;
  const value = (item, key) => {
    if (!item) return null;
    const n = Number(item.row[key]);
    return item.row[key] === null || item.row[key] === undefined || !Number.isFinite(n) ? null : n;
  };
  const delta = key => {
    if (!earlier || earlier === current) return null;
    const now = value(current, key);
    const before = value(earlier, key);
    return now === null || before === null ? null : Number((now - before).toFixed(2));
  };
  return {
    subs: value(current, 'subs'),
    views: value(current, 'views'),
    videos: value(current, 'videos'),
    subsDelta: delta('subs'),
    viewsDelta: delta('views'),
    videosDelta: delta('videos')
  };
}

function collect({
  now = Date.now(),
  days = 7,
  outcomes = [],
  routineOutcomes = [],
  artifacts = [],
  artifactOpens = [],
  radarRuns = [],
  radarDecisions = {},
  commits = [],
  activity = null,
  youtube = []
} = {}) {
  const to = timeOf(now) ?? Date.now();
  const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 7;
  const from = to - span * DAY;
  return {
    generatedAt: isoOf(to),
    from: isoOf(from),
    to: isoOf(to),
    days: span,
    agents: agentFacts(outcomes, from, to),
    automations: automationFacts(routineOutcomes, from, to),
    ring: ringFacts(artifacts, artifactOpens, from, to),
    radar: radarFacts(radarRuns, radarDecisions, from, to),
    shipping: shippingFacts(commits, from, to),
    time: timeFacts(activity),
    youtube: youtubeFacts(youtube, from, to)
  };
}

module.exports = { collect };
