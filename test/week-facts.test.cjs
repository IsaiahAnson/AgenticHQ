'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collect } = require('../lib/week-facts.cjs');

const DAY = 864e5;
const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const at = days => new Date(NOW + days * DAY).toISOString();
const day = days => at(days).slice(0, 10);
const outcome = (extra = {}) => ({ agent: 'codex', source: 'hq', status: 'succeeded', startedAt: at(-2), endedAt: at(-2), durationMs: 3600000, ...extra });

test('collect shapes the whole week and names the window', () => {
  const out = collect({ now: NOW, days: 7 });
  assert.deepEqual(Object.keys(out), ['generatedAt', 'from', 'to', 'days', 'agents', 'automations', 'ring', 'radar', 'shipping', 'time', 'youtube']);
  assert.equal(out.generatedAt, '2026-10-31T12:00:00.000Z');
  assert.equal(out.from, '2026-10-24T12:00:00.000Z');
  assert.equal(out.to, '2026-10-31T12:00:00.000Z');
  assert.equal(out.days, 7);
  assert.deepEqual(out.agents, { runs: 0, succeeded: 0, failed: 0, needsAction: 0, hours: 0, byAgent: {}, busiestDay: null });
  assert.deepEqual(out.ring, { created: 0, opened: 0, notOpened: [] });
  assert.deepEqual(out.radar, { runs: 0, findings: 0, byVerdict: { adopt: 0, trial: 0, watch: 0, skip: 0 }, top: [], decisions: { implement: 0, later: 0, dismiss: 0 } });
  assert.deepEqual(out.shipping, { commits: 0, repos: [], byDay: {}, longestStreakDays: 0 });
  assert.deepEqual(out.time, { ok: false, reason: 'no activity data' });
  assert.equal(out.youtube, null);
});

test('agent runs count inside the window only, start inclusive and now exclusive', () => {
  const out = collect({
    now: NOW,
    days: 7,
    outcomes: [
      outcome({ endedAt: at(-6), startedAt: at(-6), durationMs: 3600000 }),
      outcome({ status: 'failed', endedAt: at(-7), startedAt: at(-7), durationMs: 1800000 }),
      outcome({ status: 'needs-action', agent: 'gemini', endedAt: at(-8), startedAt: at(-8), durationMs: 3600000 }),
      outcome({ agent: 'claude', endedAt: at(0), startedAt: at(0), durationMs: 3600000 }),
      null,
      { agent: 'codex', status: 'running', endedAt: at(-1) },
      { agent: 'codex', status: 'succeeded' }
    ]
  });

  assert.equal(out.agents.runs, 2);
  assert.equal(out.agents.succeeded, 1);
  assert.equal(out.agents.failed, 1);
  assert.equal(out.agents.needsAction, 0);
  assert.equal(out.agents.hours, 1.5);
  assert.deepEqual(out.agents.byAgent, { codex: 2 });
  assert.equal(out.agents.busiestDay, day(-7));
});

test('agent runs fall back to the start time, count a run with no agent and pick the busiest day', () => {
  const out = collect({
    now: NOW,
    outcomes: [
      outcome({ agent: 'codex', endedAt: null, startedAt: at(-1), durationMs: 900000 }),
      outcome({ agent: 'claude', endedAt: at(-1), startedAt: at(-1), durationMs: 900000 }),
      outcome({ agent: 'claude', endedAt: at(-3), startedAt: at(-3), durationMs: 900000 }),
      outcome({ agent: 'gemini', endedAt: at(-3), startedAt: at(-3), durationMs: 900000 }),
      outcome({ agent: null, endedAt: at(-2), startedAt: at(-2), durationMs: 600000 }),
      outcome({ agent: 'codex', endedAt: 'not a date', startedAt: null, durationMs: 600000 })
    ]
  });

  assert.equal(out.agents.runs, 5);
  assert.equal(out.agents.hours, 1.2);
  assert.deepEqual(out.agents.byAgent, { codex: 1, claude: 2, gemini: 1 });
  assert.equal(out.agents.busiestDay, day(-3));
});

test('routine outcomes count statuses and rank the routines that keep asking for a human', () => {
  const out = collect({
    now: NOW,
    routineOutcomes: [
      { ts: at(-1), routine: 'week-in-hq', status: 'healthy' },
      { ts: at(-1), routine: 'email-triage', status: 'needs-action' },
      { ts: at(-2), routine: 'email-triage', status: 'needs-action' },
      { ts: at(-3), routine: 'deps-check', status: 'needs-action' },
      { ts: at(-4), routine: 'radar', status: 'needs-action' },
      { ts: at(-5), routine: 'radar', status: 'needs-action' },
      { ts: at(0), routine: 'later-today', status: 'healthy' },
      { ts: at(-9), routine: 'last-week', status: 'needs-action' },
      { ts: at(-2), routine: 'wrong-status', status: 'unknown' },
      { ts: at(-2), status: 'needs-action' },
      'nope'
    ]
  });

  assert.equal(out.automations.runs, 6);
  assert.equal(out.automations.healthy, 1);
  assert.equal(out.automations.needsAction, 5);
  assert.deepEqual(out.automations.topNeedsAction, [
    { routine: 'email-triage', count: 2 },
    { routine: 'radar', count: 2 },
    { routine: 'deps-check', count: 1 }
  ]);
});

test('the ring counts pages created this week, distinct files opened and the ones nobody opened', () => {
  const out = collect({
    now: NOW,
    artifacts: [
      { file: 'week-facts-check.html', title: 'Week Facts Check', created: at(-1) },
      { file: 'email-triage-20261030.html', title: 'Email triage', created: at(-2) },
      { file: 'agent-monitor.html', title: 'Agent monitor', created: at(-2) },
      { file: 'never-opened.html', title: 'Never opened', created: at(-3) },
      { file: '', title: 'No file', created: at(-3) },
      { file: 'old.html', title: 'Old', created: at(-9) },
      { file: 'at-the-edge.html', title: 'Edge', created: at(0) }
    ],
    artifactOpens: [
      { ts: at(-1), file: 'week-facts-check.html' },
      { ts: at(-1), file: 'week-facts-check.html' },
      { ts: at(-2), file: 'agent-monitor.html' },
      { ts: at(-9), file: 'nothing-this-week.html' },
      { ts: at(0), file: 'at-the-edge.html' },
      { ts: at(-2), file: null }
    ]
  });

  assert.equal(out.ring.created, 3);
  assert.equal(out.ring.opened, 1);
  assert.deepEqual(out.ring.notOpened, ['Email triage', 'Never opened']);
});

test('radar counts verdicts, lists adopt and trial finds newest first and counts decisions', () => {
  const out = collect({
    now: NOW,
    radarRuns: [
      { generatedAt: at(-1), findings: [{ verdict: 'adopt', title: 'Use node:test' }, { verdict: 'trial', title: 'Try Biome' }, { verdict: 'skip', title: 'Some fad' }, { verdict: 'nonsense', title: 'Ignored' }] },
      { generatedAt: at(-2), findings: [{ verdict: 'watch', title: 'Watch X' }, { verdict: 'trial', title: 'Try Ruff' }, { verdict: 'trial', title: 'Try One More' }, { verdict: 'trial', title: 'Too Many' }] },
      { generatedAt: at(-9), findings: [{ verdict: 'adopt', title: 'Old thing' }] },
      { generatedAt: 'nope', findings: [] },
      'nope'
    ],
    radarDecisions: {
      items: {
        'node:test': { decision: 'implement', at: at(-1) },
        biome: { decision: 'later', at: at(-1) },
        ruff: { decision: 'dismiss', at: at(-2) },
        old: { decision: 'dismiss', at: at(-9) },
        weird: { decision: 'shrug', at: at(-1) },
        broken: null
      }
    }
  });

  assert.equal(out.radar.runs, 2);
  assert.equal(out.radar.findings, 7);
  assert.deepEqual(out.radar.byVerdict, { adopt: 1, trial: 4, watch: 1, skip: 1 });
  assert.deepEqual(out.radar.top, ['Use node:test', 'Try Biome', 'Try Ruff']);
  assert.deepEqual(out.radar.decisions, { implement: 1, later: 1, dismiss: 1 });
});

test('shipping counts commits, sums repo lines, buckets days and measures the streak', () => {
  const out = collect({
    now: NOW,
    commits: [
      { repo: 'hq', commits: [
        { date: at(-0.5), subject: 'Add week facts', files: 3, insertions: 120, deletions: 4 },
        { date: at(-1), subject: 'Fix radar', files: 1, insertions: 8, deletions: 2 },
        { date: at(-2), subject: 'Trim pulse', files: 2, insertions: 20, deletions: 30 }
      ] },
      { repo: 'tools', commits: [{ date: at(-1), subject: 'Collector test', files: 2, insertions: 40, deletions: 0 }] },
      { repo: 'old', commits: [{ date: at(-9), subject: 'Old', files: 1, insertions: 5, deletions: 5 }] },
      { repo: '', commits: [{ date: at(-1) }] },
      { commits: 'nope' },
      'nope'
    ]
  });

  assert.equal(out.shipping.commits, 4);
  assert.deepEqual(out.shipping.repos, [
    { repo: 'hq', commits: 3, insertions: 148, deletions: 36 },
    { repo: 'tools', commits: 1, insertions: 40, deletions: 0 }
  ]);
  assert.deepEqual(out.shipping.byDay, { [day(-2)]: 1, [day(-1)]: 2, [day(-0.5)]: 1 });
  assert.equal(out.shipping.longestStreakDays, 3);
});

test('streak days break on a gap and never reach outside the window', () => {
  const out = collect({
    now: NOW,
    commits: [{ repo: 'hq', commits: [
      { date: at(-8) },
      { date: at(-7) }, { date: at(-6) }, { date: at(-4) }, { date: at(-3) }, { date: at(-2) }, { date: at(-1) }
    ] }]
  });
  /* the -8 commit is outside the window, so the open streak is -4..-1 */
  assert.equal(out.shipping.commits, 6);
  assert.equal(out.shipping.longestStreakDays, 4);
});

test('time passes the activity result through and reports its failure verbatim', () => {
  const ok = collect({ now: NOW, activity: { ok: true, totalHours: 12.46, byCategory: { music: 1.5, code: 8, browser: 2.5, other: 0.5 }, topApps: [] } });
  assert.deepEqual(ok.time, { ok: true, totalHours: 12.5, music: 1.5, code: 8, browser: 2.5 });

  assert.deepEqual(collect({ now: NOW, activity: { ok: false, reason: 'connect ECONNREFUSED' } }).time, { ok: false, reason: 'connect ECONNREFUSED' });
  assert.deepEqual(collect({ now: NOW, activity: null }).time, { ok: false, reason: 'no activity data' });
});

test('youtube compares the newest row in the week with the newest row before it', () => {
  const rows = [
    { ts: at(-30), subs: 100, views: 5000, videos: 12 },
    { ts: at(-10), subs: 102, views: 5100, videos: 13 },
    { ts: at(-1), subs: 104, views: 5200, videos: 14 },
    { ts: at(-2), subs: 103, views: 5150, videos: 13 }
  ];
  const out = collect({ now: NOW, youtube: rows });
  assert.deepEqual(out.youtube, { subs: 104, views: 5200, videos: 14, subsDelta: 2, viewsDelta: 100, videosDelta: 1 });
});

test('youtube deltas are null without an earlier row and the whole block is null when empty', () => {
  const only = collect({ now: NOW, youtube: [{ ts: at(-1), subs: 10, views: 20, videos: 3 }] });
  assert.deepEqual(only.youtube, { subs: 10, views: 20, videos: 3, subsDelta: null, viewsDelta: null, videosDelta: null });

  const stale = collect({ now: NOW, youtube: [{ ts: at(-10), subs: 10, views: 20, videos: 3 }] });
  assert.deepEqual(stale.youtube, { subs: 10, views: 20, videos: 3, subsDelta: null, viewsDelta: null, videosDelta: null });

  assert.equal(collect({ now: NOW, youtube: [] }).youtube, null);
  assert.equal(collect({ now: NOW, youtube: [{ ts: 'nope', subs: 1 }] }).youtube, null);
});

test('a malformed input list never throws', () => {
  const out = collect({ now: NOW, outcomes: 'nope', routineOutcomes: null, artifacts: 3, artifactOpens: undefined, radarRuns: {}, radarDecisions: 'nope', commits: null, youtube: 'nope' });
  assert.equal(out.agents.runs, 0);
  assert.equal(out.automations.runs, 0);
  assert.equal(out.ring.created, 0);
  assert.equal(out.radar.runs, 0);
  assert.equal(out.shipping.commits, 0);
  assert.equal(out.youtube, null);
});

test('a bad now or days falls back instead of producing an empty week', () => {
  const out = collect({ now: 'nope', days: 0 });
  assert.equal(out.days, 7);
  assert.ok(Number.isFinite(Date.parse(out.to)));
  assert.equal(Date.parse(out.to) - Date.parse(out.from), 7 * DAY);
});
