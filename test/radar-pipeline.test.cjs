'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const P = require('../lib/radar-profile.cjs');
const S = require('../lib/radar-sources.cjs');
const R = require('../lib/radar-score.cjs');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'radar');
const fx = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'radar.json'), 'utf8'));
const radar = () => import('../tools/ai-radar.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hq-radar-'));

// ---------- profile ----------
test('redact strips user paths (keeping repo names), emails and key-shaped strings', () => {
  /* the fake keys are split so secret scanners don't flag this file */
  const out = P.redact('see C:\\Users\\sam\\Projects\\rubric-agentic-os-v2\\server.js and C:/Users/sam/.claude/secret.md, mail sam@example.com, token ' + 'gh' + 'p_abcdefghijklmnopqrstuvwxyz0123 and ' + 'sk-' + 'ant-REDACTEDREDACTEDREDACTED');
  assert.match(out, /rubric-agentic-os-v2/);
  assert.doesNotMatch(out, /Users|sam\b|@example|ghp_|sk-ant/);
  assert.match(out, /\[path\]/);
});

test('parseFailureRegistry keeps proposed, active and watching fingerprints only', () => {
  assert.deepEqual(P.parseFailureRegistry(fx('failure-registry.md')), ['kilo-long-prompt-exit-1', 'orca-hidden-pane-no-paint']);
});

test('buildProfile stays under 1,500 chars and carries no private data', () => {
  const facts = {
    apps: Array.from({ length: 40 }, (_, i) => ({ name: `App ${i} C:\\Users\\sam\\Secret\\thing` })),
    skills: ['karakeep', 'change-watch', 'someone@example.com'], companions: ['QMD', 'ntfy'],
    routines: ['Session lessons', 'morning action brief'], failures: P.parseFailureRegistry(fx('failure-registry.md'))
  };
  const { digest, keywords } = P.buildProfile(facts, CONFIG);
  assert.ok(digest.length <= 1500, `length ${digest.length}`);
  assert.match(digest, /Agentic HQ/);
  assert.match(digest, /kilo-long-prompt-exit-1/);
  assert.doesNotMatch(digest, /C:\\Users|sam|@example\.com/);
  assert.equal(keywords.qmd, 3);
});

test('gatherFacts falls back to os-config.json when HQ is down', async () => {
  const facts = await P.gatherFacts({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, registry: path.join(FIX, 'failure-registry.md') });
  assert.equal(facts.source, 'os-config.json');
  assert.ok(Array.isArray(facts.skills));
  assert.equal(facts.failures.length, 2);
});

// ---------- lock ----------
test('lock: a live holder blocks, a dead pid or a run older than 90 minutes is taken over', async () => {
  const { acquireLock, releaseLock } = await radar();
  const dir = tmp(), now = Date.parse('2026-10-29T12:00:00Z');
  const first = acquireLock(dir, { now, pid: 111, runId: 'a', isAlive: () => true });
  assert.equal(first.ok, true);
  assert.equal(acquireLock(dir, { now: now + 60e3, pid: 222, runId: 'b', isAlive: () => true }).ok, false);
  const dead = acquireLock(dir, { now: now + 60e3, pid: 222, runId: 'b', isAlive: () => false });
  assert.deepEqual([dead.ok, dead.takenOver], [true, true]);
  const stale = acquireLock(dir, { now: now + 91 * 60e3 + 60e3, pid: 333, runId: 'c', isAlive: () => true });
  assert.deepEqual([stale.ok, stale.takenOver], [true, true]);
  assert.equal(releaseLock(dir, dead.status), false, 'a taken-over run cannot release the new holder');
  assert.equal(releaseLock(dir, stale.status), true);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.running, false);
  assert.equal(acquireLock(dir, { now, pid: 444, runId: 'd', isAlive: () => true }).ok, true);
});

test('parseArgs, runIdFor, parseDeepseekReply and fillTemplate', async () => {
  const { parseArgs, runIdFor, parseDeepseekReply, fillTemplate } = await radar();
  assert.deepEqual(parseArgs(['--dry-run', '--stage', 'triage', '--limit', '3']), { dryRun: true, noLlm: false, stage: 'triage', limit: 3 });
  assert.throws(() => parseArgs(['--stage', 'nope']), /--stage/);
  assert.equal(runIdFor(new Date(2026, 9, 30, 8, 5)), '20261030-0805');
  assert.equal(parseDeepseekReply('# DeepSeek reply\n\n## Answer\n\n[1]\n\n## Links\n\n- x'), '[1]');
  assert.equal(parseDeepseekReply('## Status: mismatch\n\n## Answer\n\n[1]'), null);
  assert.equal(fillTemplate('a {{X}} b {{Y_Z}} {{MISSING}}', { X: 1, Y_Z: 'two' }), 'a 1 b two {{MISSING}}');
});

test('hqMap names only files that exist in the repo', async () => {
  const { hqMap, makeFileExists } = await radar();
  const map = hqMap(ROOT), exists = makeFileExists(ROOT);
  assert.match(map, /lib\/hq-events\.cjs/);
  assert.equal(exists('lib/hq-events.cjs'), true);
  assert.equal(exists('lib/hq-events.cjs:12'), true);
  assert.equal(exists('../secrets.local.json'), false);
  assert.equal(exists('C:\\Windows\\win.ini'), false);
});

// ---------- end to end with stubs (no network, no models) ----------
const SINCE = Date.parse('2026-10-26T00:00:00Z');
function fixtureItems() {
  return S.mergeItems([
    ...S.parseHn(JSON.parse(fx('hn.json')), 'hn', 30),
    ...S.parseGhSearch(JSON.parse(fx('gh-search.json'))),
    ...S.parseLobsters(JSON.parse(fx('lobsters.json')), 5, SINCE)
  ]);
}
function rig(lanes, extra = {}) {
  const dir = tmp(), events = [], pushes = [], calls = [];
  const wrap = name => async (prompt, o) => { calls.push({ name, prompt }); return lanes[name](prompt, o, calls.filter(c => c.name === name).length); };
  const options = {
    root: ROOT, dir, quiet: true, log: () => {}, runId: '20261029-1200', config: { ...CONFIG, limits: { ...CONFIG.limits, reason: 3 } },
    args: { stage: 'reason', ...extra.args },
    ctx: {
      gatherFacts: async () => ({ apps: [{ name: 'Paper Lantern' }], skills: ['karakeep'], companions: ['QMD'], routines: [], failures: [], source: 'test' }),
      collect: async () => ({ items: fixtureItems(), sources: [{ id: 'hn', ok: true, items: 2, ms: 1, error: null }, { id: 'reddit', ok: false, items: 0, ms: 1, error: 'HTTP 429' }] }),
      enrich: async () => ({ calls: 0, failed: 0, enriched: 0 }),
      fetchText: async () => '<html><body>Context packing article text</body></html>',
      checkUrl: async () => true,
      usageGate: async agent => (extra.gate ? extra.gate(agent) : 0),
      lanes: { claude: wrap('claude'), codex: wrap('codex'), deepseek: wrap('deepseek') },
      emit: ev => events.push(ev), notify: async p => { pushes.push(p); return { sent: true }; },
      now: () => Date.parse('2026-10-29T16:00:00Z'),
      ...extra.ctx
    }
  };
  return { dir, events, pushes, calls, options };
}
const validFor = keys => {
  const raw = JSON.parse(fx('model-valid.json'));
  return JSON.stringify({ findings: keys.map((k, i) => ({ ...raw.findings[i % 2], key: k })) });
};
const keysIn = prompt => [...new Set([...prompt.matchAll(/"key": "([^"]+)"/g)].map(m => m[1]))].filter(k => /^(gh|url|pkg):/.test(k));

test('pipeline: invalid model output gets one repair, latest.json validates, seen.json and the event are written', async () => {
  const { runPipeline } = await radar();
  let keys = [];
  const r = rig({
    deepseek: async () => { throw Object.assign(new Error('deepseek-ask exited 2'), { code: 2 }); },
    claude: async (prompt, o, n) => { if (n === 1) { keys = keysIn(prompt); return fx('model-invalid.txt'); } return validFor(keys); },
    codex: async () => { throw new Error('codex should not run'); }
  });
  const out = await runPipeline(r.options);
  const latest = JSON.parse(fs.readFileSync(path.join(r.dir, 'latest.json'), 'utf8'));
  assert.deepEqual(R.validateRun(latest), []);
  assert.equal(latest.status, 'partial', 'a failed source and a failed sweep make the run partial');
  assert.equal(latest.lanes.reason.agent, 'claude');
  assert.equal(latest.lanes.deepseek.ok, false);
  assert.equal(r.calls.filter(c => c.name === 'claude').length, 3, 'one call, one repair, then critique');
  assert.match(r.calls.filter(c => c.name === 'claude')[1].prompt, /did not validate/);
  assert.match(r.calls.filter(c => c.name === 'claude')[2].prompt, /Critique this AI Radar top 8/);
  assert.equal(latest.counts.reasoned, latest.findings.length);
  assert.ok(latest.findings.every(f => f.reasonedBy === 'claude' && typeof f.pinned === 'string'));
  assert.deepEqual(latest.findings.map(f => f.id), R.sortFindings(latest.findings).map(f => f.id), 'verdict first, then score');
  assert.ok(fs.existsSync(path.join(r.dir, 'runs', '20261029-1200.json')));
  const seen = JSON.parse(fs.readFileSync(path.join(r.dir, 'seen.json'), 'utf8'));
  assert.ok(seen['gh:acme/agent-tool'].firstSeen);
  assert.equal(r.events[0].type, 'radar.ready');
  assert.equal(r.pushes.length, 0, 'no adopt >= 75, no push');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'status.json'), 'utf8')).running, false);
  assert.equal(out.how, 'done');
  assert.doesNotMatch(r.calls[0].prompt, new RegExp('C:\\\\Users|' + path.basename(os.homedir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'prompts carry no private paths');
});

test('pipeline: Claude gated out -> Codex; every lane failing -> triage-only watch findings', async () => {
  const { runPipeline } = await radar();
  const ok = rig({
    deepseek: async () => { throw Object.assign(new Error('down'), { code: 2 }); },
    claude: async () => { throw new Error('claude must be skipped'); },
    codex: async prompt => validFor(keysIn(prompt))
  }, { gate: agent => (agent === 'claude' ? 3 : 4) });
  const a = (await runPipeline(ok.options)).run;
  assert.equal(a.lanes.reason.agent, 'codex');
  assert.match(a.lanes.reason.note, /claude: usage low/);
  assert.equal(ok.calls.filter(c => c.name === 'claude').length, 0, 'main pass and critique both honor the gate');

  const bad = rig({
    deepseek: async () => ({ text: 'I cannot help with that', chat: 'https://chat.deepseek.com/a/chat/s/x' }),
    claude: async () => { throw new Error('claude exited 1'); },
    codex: async () => { throw new Error('codex exited 1: usage limit'); }
  });
  const b = (await runPipeline(bad.options)).run;
  assert.equal(b.lanes.reason.agent, 'none');
  assert.equal(b.status, 'partial');
  assert.ok(b.findings.length > 0 && b.findings.every(f => f.verdict === 'watch' && f.reasonedBy === 'none' && f.confidence === 'low'));
  assert.deepEqual(R.validateRun(b), []);
  const seen = JSON.parse(fs.readFileSync(path.join(bad.dir, 'seen.json'), 'utf8'));
  for (const f of b.findings) assert.equal(seen[f.key]?.fingerprint, undefined, `${f.key} was never reasoned, so the next scan offers it again`);
});

test('pipeline: --no-llm and --dry-run write nothing outside work/; a held lock skips the run', async () => {
  const { runPipeline, acquireLock } = await radar();
  const r = rig({ deepseek: async () => { throw new Error('no'); }, claude: async () => { throw new Error('no'); }, codex: async () => { throw new Error('no'); } },
    { args: { noLlm: true, dryRun: true } });
  const out = await runPipeline(r.options);
  assert.equal(out.how, 'dry');
  assert.equal(r.calls.length, 0);
  assert.equal(fs.existsSync(path.join(r.dir, 'latest.json')), false);
  assert.equal(fs.existsSync(path.join(r.dir, 'seen.json')), false);
  assert.ok(fs.existsSync(path.join(r.dir, 'work', 'dry-20261029-1200.json')));
  assert.equal(r.events.length, 0);

  const busy = tmp();
  acquireLock(busy, { pid: process.ppid, runId: 'other' });   /* the parent process is alive: a real, live holder */
  const skipped = await runPipeline({ ...r.options, dir: busy });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.holder.runId, 'other');
});

test('pipeline: critique reorders findings and reranks incumbents without losing reasons', async () => {
  const { runPipeline, mergeFindings } = await radar(), standings = require('../lib/standings.cjs');
  let r;
  r = rig({
    deepseek: async () => { throw Object.assign(new Error('down'), { code: 2 }); },
    codex: async () => { throw new Error('not used'); },
    claude: async prompt => {
      if (!prompt.startsWith('Critique')) return validFor(keysIn(prompt));
      const top = JSON.parse(/\n(\[[\s\S]*\])\n/.exec(prompt)[1]);
      const drop = top.find(x => x.ref !== 'gh:old/old')?.key;
      return JSON.stringify(top.map(x => ({ key: x.key, delta: -15, verdict: x.key === drop ? 'drop' : 'demote', critique: 'Risk', reason: 'Too risky' })));
    }
  });
  const old = { id: 'gh-old-old', key: 'gh:old/old', title: 'Old', kind: 'tool', url: 'https://example.com', score: { total: 99 }, sources: [], reasoning: 'Original reason', verdict: 'watch' };
  const board = mergeFindings(standings.emptyStore('radar'), { runId: 'old', startedAt: '2026-10-01', findings: [old] });
  standings.save(path.join(r.dir, 'standings.json'), board);
  const result = await runPipeline(r.options), saved = standings.load(path.join(r.dir, 'standings.json'), 'radar');
  const incumbent = Object.values(saved.items).find(x => x.key === old.key);
  assert.equal(incumbent.baseScore, 84);
  assert.equal(incumbent.reason, 'Original reason');
  assert.equal(incumbent.data.critique.critique, 'Risk');
  assert.equal(incumbent.seenCount, 1);
  assert.equal(result.run.findings.filter(f => f.score.total === 0).length, 1);
  assert.ok(result.run.findings[0].score.total > 0);
  assert.equal(r.events[0].data.top.id, result.run.findings[0].id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'latest.json'))).findings[0].id, result.run.findings[0].id);
  const dropped = result.run.findings.find(f => f.score.total === 0);
  assert.equal(dropped.verdict, 'skip', 'a critique drop becomes a skip');
  assert.ok(dropped.flags.includes('critique-drop'));
  assert.equal(result.run.findings.at(-1).id, dropped.id, 'the dropped item sorts last');
  assert.deepEqual(R.validateRun(result.run), [], 'verdict first, then the post-critique score');

  const critiques = () => r.calls.filter(c => c.prompt.startsWith('Critique')).length, before = critiques();
  r.options.runId = '20261029-1201';
  await runPipeline(r.options);
  const again = Object.values(standings.load(path.join(r.dir, 'standings.json'), 'radar').items).find(x => x.key === old.key);
  assert.equal(again.baseScore, 84, 'a second scan does not stack the critique delta');
  assert.equal(again.data.critique.base, 99, 'the pre-critique base is kept with the critique');
  assert.equal(critiques(), before, 'nothing new and the whole top 8 already critiqued: no critique call');
});

test('pipeline: a late reopen is preserved and corrupted standings do not prevent latest', async () => {
  const { runPipeline, mergeFindings } = await radar(), standings = require('../lib/standings.cjs');
  const r = rig({ deepseek: async () => {}, claude: async () => {}, codex: async () => {} }, { args: { noLlm: true } });
  const old = { id: 'old-id', key: 'gh:old/old', title: 'Old', kind: 'tool', url: 'https://example.com', score: { total: 80 }, sources: [], verdict: 'watch' };
  let board = mergeFindings(standings.emptyStore('radar'), { runId: 'old', startedAt: '2026-10-01', findings: [old] });
  const id = Object.keys(board.items)[0];
  board = standings.setStatus(board, id, 'trashed');
  standings.save(path.join(r.dir, 'standings.json'), board);
  fs.writeFileSync(path.join(r.dir, 'decisions.json'), JSON.stringify({ items: { [old.id]: { decision: 'dismiss', key: old.key, version: 'v1.0' } } }));
  r.options.ctx.collect = async () => {
    standings.save(path.join(r.dir, 'standings.json'), standings.setStatus(board, id, 'open'));
    fs.writeFileSync(path.join(r.dir, 'decisions.json'), JSON.stringify({ items: {} }));
    return { items: fixtureItems(), sources: [{ id: 'test', ok: true, items: 1 }] };
  };
  await runPipeline(r.options);
  assert.equal(standings.load(path.join(r.dir, 'standings.json'), 'radar').items[id].status, 'open');

  const bad = rig({ deepseek: async () => {}, claude: async () => {}, codex: async () => {} }, { args: { noLlm: true } });
  fs.writeFileSync(path.join(bad.dir, 'standings.json'), '{broken');
  assert.equal((await runPipeline(bad.options)).how, 'done');
  assert.equal(fs.readFileSync(path.join(bad.dir, 'standings.json'), 'utf8'), '{broken');
  assert.ok(fs.existsSync(path.join(bad.dir, 'latest.json')));
  assert.match(require('../lib/ai-radar.cjs').createRadar({ dir: bad.dir }).overview().standingsError, /unreadable/);
});

test('pipeline: DeepSeek reason timeout cannot exceed the remaining deadline', async () => {
  const { runPipeline } = await radar();
  let clock = Date.parse('2026-10-29T16:00:00Z'), timeout;
  const r = rig({
    deepseek: async (prompt, opts) => {
      if (opts.tag === 'sweep') return { text: '[]', chat: '' };
      if (opts.tag === 'shortlist') return { text: '[]', chat: '' };
      timeout = opts; return { text: validFor(keysIn(prompt)), chat: '' };
    },
    claude: async () => { throw new Error('not used'); }, codex: async () => { throw new Error('not used'); }
  }, { gate: () => 3, ctx: { now: () => clock, gatherFacts: async () => { clock += 35 * 60000; return { apps: [], skills: [], companions: [], routines: [], failures: [], source: 'test' }; } } });
  /* the DeepSeek lane is opt-in (config/radar.json lanes.order), so this test turns it on itself */
  r.options.config = { ...r.options.config, limits: { ...r.options.config.limits, reason: 12 },
    lanes: { ...r.options.config.lanes, order: ['claude', 'codex', 'deepseek'] } };
  await runPipeline(r.options);
  assert.equal(timeout.timeoutSec, 420);
  assert.equal(timeout.timeoutMs, 420000);
});

test('pipeline: dated articles stay suppressed and enrichment can reveal a changed release', async () => {
  const { runPipeline } = await radar();
  let version = 'v1.0.0', enriched = 0;
  const article = () => S.makeItem({ url: 'https://example.com/article', title: 'AI agent article', kind: 'article',
    date: '2026-10-28', source: { id: 'test' } });
  const repo = () => S.makeItem({ url: 'https://github.com/acme/agent', title: 'Agent', source: { id: 'test' } });
  /* Reasoned items get fingerprints (unreasoned ones come back), and enrichment sets lastReleaseTag as the real one does. */
  const r = rig({ deepseek: async () => { throw Object.assign(new Error('down'), { code: 2 }); }, claude: async prompt => validFor(keysIn(prompt)), codex: async () => {} }, {
    ctx: {
      collect: async () => ({ items: [article(), repo()], sources: [{ id: 'test', ok: true, items: 2 }] }),
      enrich: async rows => { enriched++; for (const item of rows) item.signals.lastReleaseTag = version; return { enriched: rows.length, calls: 1, failed: 0 }; }
    }
  });
  const first = await runPipeline(r.options);
  assert.equal(first.run.counts.triaged, 2);
  const seen = JSON.parse(fs.readFileSync(path.join(r.dir, 'seen.json')));
  assert.equal(seen[article().key].fingerprint, '2026-10-28');
  r.options.runId = '20261029-1201';
  const second = await runPipeline(r.options);
  assert.equal(second.run.counts.triaged, 0);
  version = 'v2.0.0';
  r.options.runId = '20261029-1202';
  const third = await runPipeline(r.options);
  assert.equal(third.run.counts.triaged, 1);
  assert.equal(third.run.findings[0].key, repo().key);
  assert.equal(enriched, 3);
});
