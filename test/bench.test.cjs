'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bench = require('../lib/bench.cjs');

const TZ = 'America/New_York';
const NOW = Date.parse('2026-10-28T23:22:00Z');   // Wed 19:22 New York
const MIN = 60000;
const meter = (id, windows, extra = {}) => ({ id, t: NOW - MIN, windows, ...extra });

test('Orca reap queue fixture is exposed as count plus items; missing is empty', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-keeps-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json'), items = [{ run: 'r1', dispatch: 'd1', task: 't1', reasons: ['blocked'], since: 'now', fingerprint: 'x' }];
  fs.writeFileSync(file, JSON.stringify({ generated: 'now', items }));
  assert.deepEqual(bench.readOrcaKeeps(file), { count: 1, items });
  assert.deepEqual(bench.readOrcaKeeps(path.join(dir, 'missing.json')), { count: 0, items: [] });
  assert.deepEqual(bench.collect({ orcaKeeps: bench.readOrcaKeeps(file) }).orcaKeeps, { count: 1, items });
});

test('capacity text: free, low and out with its reset', () => {
  assert.deepEqual(bench.capacity('codex', meter('codex', [{ label: '5h', used: 12, resetsAt: NOW + 3 * 36e5 }, { label: 'week', used: 41 }]), { now: NOW, tz: TZ }).text, 'free');
  const low = bench.capacity('claude', meter('claude', [{ label: '5h', used: 20 }, { label: 'week', used: 84.6 }]), { now: NOW, tz: TZ });
  assert.equal(low.text, 'low (85%)', 'the tightest window wins');
  assert.equal(low.window, 'week');
  const out = bench.capacity('codex', meter('codex', [{ label: '5h', used: 100, resetsAt: NOW + 43 * MIN }]), { now: NOW, tz: TZ });
  assert.deepEqual([out.state, out.text, out.back], ['out', 'out, back in 43m', '8:05 PM']);
  assert.equal(bench.capacity('copilot', meter('copilot', [{ label: 'credits', used: 94.7, resetsAt: NOW + 72 * 36e5 }]), { now: NOW, tz: TZ }).text, 'out, back in 3d 0h');
  assert.equal(bench.capacity('codex', meter('codex', [{ label: '5h', used: 5 }], { t: NOW - 45 * MIN }), { now: NOW, tz: TZ }).text, 'free · stale');
  assert.equal(bench.capacity('codex', null, { now: NOW }).text, 'no reading');
  assert.equal(bench.capacity('deepseek', null).text, 'no meter');
  assert.equal(bench.capacity('opencode', meter('opencode', [{ label: '5h', used: 99 }])).text, 'no meter');
});

test('capacity uses the usage-check gate: a window past its reset is not stale', () => {
  const rolled = meter('codex', [{ label: '5h', used: 0, rolledOver: true, resetsAt: NOW + 5 * 36e5 }], { t: NOW - 6 * 60 * MIN });
  assert.equal(bench.capacity('codex', rolled, { now: NOW }).text, 'free');
});

test('queue head: assigned worker from the spec, waits for an out worker', () => {
  const queue = [
    { name: 'hq-outcome-feed', path: 'a.md', status: 'done' },
    { name: 'hq-attention-budget', path: 'b.md', status: 'drafted' }
  ];
  const specs = { 'b.md': '@HQ-HANDOFF.md\nMode: Orchestrated\nWorkers: Codex for the build, Claude reviews\n' };
  const lanes = [{ id: 'codex', capacity: { state: 'out', back: '8:05 PM' } }, { id: 'claude', capacity: { state: 'free' } }];
  const n = bench.nextUp(queue, { specText: p => specs[p], lanes, now: NOW });
  assert.deepEqual(n.head, { name: 'hq-outcome-feed', status: 'done' });
  assert.deepEqual(n.item, { name: 'hq-attention-budget', status: 'drafted', worker: 'codex', path: 'b.md' });
  assert.equal(n.text, 'hq-attention-budget starts when Codex is back, ~8:05 PM');
  lanes[0].capacity = { state: 'free' };
  assert.equal(bench.nextUp(queue, { specText: p => specs[p], lanes }).text, 'hq-attention-budget next, for Codex');
  assert.equal(bench.nextUp(queue, { specText: () => 'Builder: Claude (your call)', lanes }).item.worker, 'claude');
  assert.equal(bench.nextUp(queue, { specText: () => 'Paste into a Claude **desktop app** session.\n\nThen ask Codex.', lanes }).item.worker, 'claude', 'opening line');
  assert.equal(bench.nextUp(queue, { specText: () => '@HQ-HANDOFF.md\nMode: Solo\nUse Codex later', lanes }).text, 'hq-attention-budget next, no worker named');
  assert.equal(bench.nextUp([{ name: 'x', status: 'building', agent: 'claude', startedAt: NOW - 12 * MIN }], { lanes, now: NOW }).text, 'x building on Claude · 12m');
  assert.equal(bench.nextUp([queue[0]], {}).text, 'queue clear (hq-outcome-feed done)');
  assert.equal(bench.nextUp([], {}).text, 'queue empty');
});

test('worker names: the first one named wins', () => {
  assert.equal(bench.workerOf('OpenCode DeepSeek, then Codex'), 'opencode');
  assert.equal(bench.workerOf('DeepSeek web'), 'deepseek');
  assert.equal(bench.workerOf('Kilo'), null);
  assert.equal(bench.shortTask('Follow C:\\Users\\sam\\Projects\\orbit-notes\\handoffs\\specs\\hq-widgets-4-worker-bench.md exactly.'), 'Follow hq-widgets-4-worker-bench exactly.');
});

const PS = { worktrees: [
  { displayName: 'main', agents: [
    { agentType: 'claude', state: 'working', paneKey: 'tab1:leaf1', prompt: 'Read C:\\x\\specs\\hq-bench.md and build it', stateStartedAt: NOW - 30 * MIN },
    { agentType: 'codex', state: 'done', mainAgent: { state: 'done', outcome: 'success' }, prompt: 'old', stateStartedAt: NOW - 600 * MIN }
  ] },
  { displayName: 'oc', agents: [{ agentType: 'opencode', state: 'done', mainAgent: { state: 'done', outcome: 'failure' }, stateStartedAt: NOW - 90 * MIN }] }
] };
const TERMS = { terminals: [{ handle: 'term_aaaa1111-2222-3333-4444-555566667777', tabId: 'tab1', leafId: 'leaf1' }] };
const TABS = { tabs: [{ url: 'https://chat.deepseek.com/a/chat/s/1' }, { url: 'https://example.com/' }] };

test('collect: lanes with now, dedupe, terminal link, DeepSeek and OpenCode availability', () => {
  const d = bench.collect({
    now: NOW, tz: TZ,
    stats: { meters: [meter('codex', [{ label: '5h', used: 100, resetsAt: NOW + 43 * MIN }]), meter('claude', [{ label: '5h', used: 4 }])] },
    hqSessions: [
      { status: 'working', model: 'claude-opus-5-5', title: 'same run', startedAt: NOW - 30 * MIN + 800 },
      { status: 'waiting', model: 'claude-opus-5-5', title: 'another chat', startedAt: NOW - 5 * MIN },
      { status: 'idle', model: 'gpt-5', title: 'asleep' }
    ],
    jobs: [{ jobId: 'karakeep-1793231000000', id: 'karakeep', agent: 'copilot', status: 'running', started: NOW - 2 * MIN }],
    orca: { ps: PS, terminals: TERMS, tabs: TABS },
    queue: [{ name: 'hq-bench', path: 's.md', status: 'drafted' }], specText: () => 'Builder: Codex'
  });
  assert.deepEqual(d.lanes.map(l => l.id), ['codex', 'claude', 'copilot', 'deepseek', 'opencode']);
  const [codex, claude, copilot, deepseek, opencode] = d.lanes;
  assert.equal(codex.state, 'out');
  assert.deepEqual(claude.now.map(i => [i.source, i.title, i.minutes]), [['orca', 'Read hq-bench and build it', 30], ['local', 'another chat', 5]], 'the same run from local transcripts is dropped');
  assert.deepEqual(claude.open, { kind: 'terminal', handle: 'term_aaaa1111-2222-3333-4444-555566667777' });
  assert.deepEqual(copilot.open, { kind: 'log', file: 'karakeep-1793231000000.log' });
  assert.equal(copilot.capacity.text, 'no reading');
  assert.deepEqual([deepseek.capacity.text, deepseek.avail.text, deepseek.state], ['no meter', '1 chat tab open', 'idle']);
  assert.deepEqual([opencode.avail.text, opencode.state], ['last run failed 1h 30m ago', 'off']);
  assert.equal(d.next.text, 'hq-bench starts when Codex is back, ~8:05 PM');
  assert.equal(d.orca.running, true);
});

test('missing Orca degrades cleanly', () => {
  const d = bench.collect({ now: NOW, stats: { meters: [meter('codex', [{ label: '5h', used: 10 }])] }, orca: { error: 'Orca not running' },
    hqSessions: [{ status: 'working', entrypoint: 'codex', title: 'codex chat', startedAt: NOW - MIN }] });
  assert.deepEqual(d.orca, { running: false, note: 'Orca not running' });
  const lane = id => d.lanes.find(l => l.id === id);
  assert.equal(lane('codex').capacity.text, 'free');
  assert.deepEqual(lane('codex').now.map(i => i.title), ['codex chat'], 'local sessions still show');
  assert.equal(lane('codex').open, null);
  assert.deepEqual([lane('deepseek').avail.text, lane('opencode').avail.text], ['Orca not running', 'Orca not running']);
  assert.equal(d.next.text, 'queue empty');
});

test('collect exposes ordered meters, refresh time and Claude API cost', () => {
  const stats = { fetched: '2026-10-28T23:21:30.000Z', meters: [
    meter('copilot', [{ label: 'credits', used: 12.6, resetsAt: NOW + MIN, estimated: true }], { name: 'GitHub Copilot', plan: 'Pro' }),
    meter('claude-api', [], { note: '$3.42 organization API use this month' }),
    meter('codex', [{ label: '5h', used: null }, { label: 'week', used: 44.5, rolledOver: true }], { name: 'Codex', plan: 'Plus' }),
    meter('claude', [{ label: '5h', used: 8.4 }], { name: 'Claude', plan: 'Max' })
  ] };
  const d = bench.collect({ now: NOW, stats, orca: { ps: { worktrees: [] } } });
  assert.equal(d.lastRefresh, stats.fetched);
  assert.deepEqual(d.meters, [
    { id: 'claude', name: 'Claude', plan: 'Max', windows: [{ label: '5h', usedPct: 8, resetsAt: null, estimated: false, rolledOver: false }] },
    { id: 'codex', name: 'Codex', plan: 'Plus', windows: [
      { label: '5h', usedPct: null, resetsAt: null, estimated: false, rolledOver: false },
      { label: 'week', usedPct: 45, resetsAt: null, estimated: false, rolledOver: true }
    ] },
    { id: 'copilot', name: 'GitHub Copilot', plan: 'Pro', windows: [{ label: 'credits', usedPct: 13, resetsAt: NOW + MIN, estimated: true, rolledOver: false }] }
  ]);
  assert.deepEqual(d.claudeApi, { spend: '$3.42 organization API use this month', consoleLink: 'https://console.anthropic.com/settings/cost' });
  assert.equal(bench.collect({ now: NOW }).claudeApi, null);
  assert.equal(bench.collect({ now: NOW, stats: { meters: [meter('claude-api', [])] } }).claudeApi.spend, null);
});

test('stop uses the shared 90% usage gate', () => {
  const stopped = bench.collect({ now: NOW, stats: { meters: [
    meter('codex', [{ label: '5h', used: 92 }, { label: 'week', used: 10 }]),
    meter('claude', [{ label: '5h', used: 85 }])
  ] } });
  assert.deepEqual(stopped.stop, [{ worker: 'codex', window: '5h', used: 92 }]);
  const safe = bench.collect({ now: NOW, stats: { meters: [meter('codex', [{ label: '5h', used: 85 }])] } });
  assert.deepEqual(safe.stop, []);
});

test('Start on Codex availability and refusal reasons', () => {
  const queued = [{ name: 'next-spec', path: 'C:\\specs\\next-spec.md', status: 'drafted', agent: 'codex' }];
  const idle = { now: NOW, queue: queued, orca: { ps: { worktrees: [] } } };
  const available = bench.collect(idle);
  assert.deepEqual(available.start, { available: true, reason: null });
  assert.equal(available.next.item.path, queued[0].path);
  assert.equal(bench.collect({ now: NOW, queue: queued }).start.reason, 'Orca not running');
  assert.equal(bench.collect({ now: NOW, orca: idle.orca }).start.reason, 'nothing queued');
  assert.equal(bench.collect({ ...idle, queue: [{ ...queued[0], status: 'building' }] }).start.reason, 'already building');
  assert.equal(bench.collect({ ...idle, queue: [{ ...queued[0], agent: 'claude' }] }).start.reason, 'next item is for Claude');
  assert.equal(bench.collect({ ...idle, hqSessions: [{ status: 'working', entrypoint: 'codex', title: 'busy' }] }).start.reason, 'Codex is busy');
  assert.equal(bench.collect({ ...idle, stats: { meters: [meter('codex', [{ label: '5h', used: 93 }])] } }).start.reason, 'Codex 5h at 93%');
});
