'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const R = require('../lib/radar-score.cjs');

const FIX = path.join(__dirname, 'fixtures', 'radar');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'radar.json'), 'utf8'));
const KEYS = new Set(['gh:acme/agent-tool', 'url:https://blog.example.org/context-packing']);
const exists = p => ['lib/orca-reap.cjs', 'lib/context-pack.cjs'].includes(p);

function mk(over = {}) {
  const base = {
    key: 'gh:acme/agent-tool', title: 'acme/agent-tool', url: 'https://github.com/acme/agent-tool', kind: 'repo',
    text: 'Run Claude Code subagents in git worktrees, as an MCP server', sources: [{ id: 'github-search', url: 'x' }, { id: 'hn', url: 'y' }],
    readme: 'Works with Claude Code and Codex. Exposes an MCP server.', releaseNotes: '',
    signals: {
      enriched: true, stars: 540, starsPerDay: 270, sourceCount: 2, license: 'MIT', diskKB: 900, readmeBytes: 4000, releases: 2,
      lastReleaseAt: '2026-10-28T00:00:00Z', lastCommitAt: '2026-10-28T00:00:00Z', commits30: 25, contributors90: 4, openIssues: 3, closedIssues: 9, topics: ['mcp']
    }
  };
  return { ...base, ...over, signals: { ...base.signals, ...(over.signals || {}) } };
}
const scoreOf = it => R.scoreItem(it, { config: CONFIG, now: NOW });

test('weights add up to 100 and a healthy, relevant repo scores high', () => {
  assert.equal(Object.values(CONFIG.weights).reduce((a, b) => a + b, 0), 100);
  const s = scoreOf(mk());
  assert.ok(s.total >= 75, `total ${s.total}`);
  assert.equal(s.multiplier, 1);
  assert.deepEqual(Object.keys(s.parts), ['relevance', 'maintenance', 'substance', 'momentum', 'agreement', 'license']);
  for (const [k, v] of Object.entries(s.parts)) assert.ok(v >= 0 && v <= CONFIG.weights[k], `${k}=${v}`);
});

test('liveness multiplier: x0.35 with no commit in 90 days, x0.6 with no release in 6 months', () => {
  const dead = scoreOf(mk({ signals: { lastCommitAt: '2026-06-01T00:00:00Z', commits30: 0 } }));
  assert.equal(dead.multiplier, 0.35);
  const stale = scoreOf(mk({ signals: { lastReleaseAt: '2026-03-01T00:00:00Z' } }));
  assert.equal(stale.multiplier, 0.6);
  const noReleases = scoreOf(mk({ signals: { releases: 0, lastReleaseAt: '' } }));
  assert.equal(noReleases.multiplier, 1, 'a repo that never ships releases is not penalized for it');
  assert.ok(dead.total < scoreOf(mk()).total * 0.4);
});

test('hype penalty: many stars with few commits loses momentum', () => {
  const hype = scoreOf(mk({ signals: { stars: 5000, commits30: 1 } }));
  assert.ok(hype.flags.includes('hype'));
  assert.ok(hype.parts.momentum < scoreOf(mk()).parts.momentum);
});

test('license: OSI full marks, missing zero, unknown flagged', () => {
  assert.equal(scoreOf(mk()).parts.license, 5);
  const none = scoreOf(mk({ signals: { license: '' } }));
  assert.equal(none.parts.license, 0);
  assert.ok(none.flags.includes('license-none'));
  assert.ok(scoreOf(mk({ signals: { license: 'NOASSERTION' } })).flags.includes('license-unknown'));
});

test('relevance: an on-profile repo beats an off-profile one; generic README words cannot max it out', () => {
  const off = mk({ title: 'someone/recipes', text: 'A recipe website', readme: 'ai agent cli llm markdown dashboard skills plugin tui terminal', signals: { topics: [] } });
  const on = scoreOf(mk()).parts.relevance, offRel = scoreOf(off).parts.relevance;
  assert.ok(on > offRel * 2, `on ${on} off ${offRel}`);
  assert.ok(offRel < 10);
});

test('substance: an empty or README-only repo scores low', () => {
  assert.equal(scoreOf(mk({ signals: { diskKB: 0 } })).parts.substance, 0);
  assert.ok(scoreOf(mk({ signals: { diskKB: 10, readmeBytes: 9000, releases: 0, topics: [] } })).parts.substance < 3);
});

test('agreement grows with independent sources; non-repo items get neutral maintenance', () => {
  const one = mk({ sources: [{ id: 'hn', url: 'x' }], signals: { sourceCount: 1 } });
  const three = mk({ signals: { sourceCount: 3 } });
  assert.ok(scoreOf(three).parts.agreement > scoreOf(one).parts.agreement);
  const article = { key: 'url:https://simonwillison.net/x', title: 'Claude Code hooks', url: 'https://simonwillison.net/x', kind: 'article', text: 'about hooks', sources: [{ id: 'simonwillison', url: 'https://simonwillison.net/x' }], signals: { sourceCount: 1 } };
  const s = scoreOf(article);
  assert.ok(s.parts.maintenance > 0 && s.multiplier === 1);
});

test('extractJson finds JSON in fences, prose and bare text', () => {
  assert.deepEqual(R.extractJson('[1,2]'), [1, 2]);
  assert.equal(R.extractJson(fs.readFileSync(path.join(FIX, 'model-invalid.txt'), 'utf8')).findings.length, 1);
  assert.deepEqual(R.extractJson('Sure! {"a": 1} hope that helps'), { a: 1 });
  assert.throws(() => R.extractJson('no json here'), /no parseable JSON/);
});

test('validateReasoned accepts the contract and reports every problem', () => {
  const good = R.validateReasoned(JSON.parse(fs.readFileSync(path.join(FIX, 'model-valid.json'), 'utf8')), { keys: KEYS, fileExists: exists });
  assert.deepEqual(good.errors, []);
  assert.equal(good.findings.size, 2);
  assert.equal(good.findings.get('gh:acme/agent-tool').pinnedClaim, 'v0.3.0');
  const bad = R.validateReasoned(R.extractJson(fs.readFileSync(path.join(FIX, 'model-invalid.txt'), 'utf8')), { keys: KEYS, fileExists: exists });
  assert.equal(bad.findings.size, 0);
  assert.match(bad.errors[0], /verdict must be/);
  assert.match(bad.errors[0], /reasoning\.counter is required/);
  assert.match(bad.errors[0], /lib\/does-not-exist\.cjs/);
  assert.match(R.validateReasoned({ nope: 1 }).errors[0], /JSON array/);
  const unknownKey = R.validateReasoned([{ ...JSON.parse(fs.readFileSync(path.join(FIX, 'model-valid.json'), 'utf8')).findings[0], key: 'gh:x/y' }], { keys: KEYS });
  assert.match(unknownKey.errors[0], /key must be one of/);
});

test('validateReasoned caps confidence for the DeepSeek lane; dropMissingFiles repairs file lists', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, 'model-valid.json'), 'utf8'));
  const capped = R.validateReasoned(raw, { keys: KEYS, maxConfidence: 'medium' });
  assert.equal(capped.findings.get('url:https://blog.example.org/context-packing').confidence, 'medium');
  raw.findings[0].reasoning.fit[0].files.push('lib/ghost.cjs');
  assert.equal(R.validateReasoned(raw, { keys: KEYS, fileExists: exists }).findings.size, 1);
  assert.equal(R.validateReasoned(R.dropMissingFiles(raw, exists), { keys: KEYS, fileExists: exists }).findings.size, 2);
});

test('sortFindings orders by verdict then score', () => {
  const f = (verdict, total) => ({ verdict, score: { total } });
  assert.deepEqual(R.sortFindings([f('watch', 90), f('adopt', 50), f('trial', 70), f('adopt', 80), f('skip', 99)]).map(x => `${x.verdict}${x.score.total}`),
    ['adopt80', 'adopt50', 'trial70', 'watch90', 'skip99']);
});

test('watchGate ignores mobile tags, reviews dependency notes, and digests plain patches', () => {
  const cfg = { watchDepends: ['hooks', 'permission'], watchIgnoreTags: ['mobile', 'android'] };
  const watched = over => mk({ ...over, signals: { watchlist: true, releaseTag: 'v1.2.4', ...(over.signals || {}) } });
  assert.deepEqual(R.watchGate(watched({ signals: { releaseTag: 'mobile-android-v0.0.61' } }), cfg).reason, 'ignored-tag');
  assert.equal(R.watchGate(watched({ releaseNotes: 'Fix hooks dispatch on Windows', lastVersion: 'v1.2.3' }), cfg).review, true);
  const digest = R.watchGate(watched({ releaseNotes: '- Improve colors', lastVersion: 'v1.2.3' }), cfg);
  assert.equal(digest.review, false);
  assert.equal(digest.note, 'Improve colors');
});

test('validateReasoned forces a held falsify check to watch and caps unchecked trials', () => {
  const base = JSON.parse(fs.readFileSync(path.join(FIX, 'model-valid.json'), 'utf8')).findings[0];
  base.reasoning.evidence.push({ claim: 'Falsify check', checked: true, how: 'Grep lib/', quote: 'worktree cleanup', kind: 'falsify', holds: true });
  const held = R.validateReasoned([base], { keys: new Set([base.key]) }).findings.get(base.key);
  assert.equal(held.verdict, 'watch');
  assert.ok(held.flags.includes('falsified'));
  const unchecked = JSON.parse(fs.readFileSync(path.join(FIX, 'model-valid.json'), 'utf8')).findings[0];
  unchecked.confidence = 'high';
  const capped = R.validateReasoned([unchecked], { keys: new Set([unchecked.key]) }).findings.get(unchecked.key);
  assert.equal(capped.confidence, 'low');
  assert.ok(capped.flags.includes('falsify-unchecked'));
});

test('verifyQuotes finds exact and whitespace-insensitive quotes and marks missing claims', () => {
  const finding = { confidence: 'high', flags: [], reasoning: { evidence: [
    { claim: 'exact', checked: true, how: 'excerpt', quote: 'Supports Claude Code' },
    { claim: 'spacing', checked: true, how: 'excerpt', quote: 'MCP server for agents' },
    { claim: 'missing', checked: true, how: 'excerpt', quote: 'not present anywhere' }
  ] } };
  R.verifyQuotes(finding, { texts: ['Supports Claude Code. MCP\n  server for agents.'] });
  assert.equal(finding.reasoning.evidence[0].checked, true);
  assert.equal(finding.reasoning.evidence[1].checked, true);
  assert.equal(finding.reasoning.evidence[2].unverified, true);
  assert.equal(finding.confidence, 'high', 'one of three unverified does not cap confidence');
  finding.reasoning.evidence[1].quote = 'also absent'; finding.reasoning.evidence[1].checked = true;
  R.verifyQuotes(finding, { texts: ['Supports Claude Code.'] });
  assert.equal(finding.confidence, 'low');
  assert.ok(finding.flags.includes('unverified-evidence'));
});
