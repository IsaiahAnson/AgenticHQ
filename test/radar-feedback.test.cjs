'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const F = require('../lib/radar-feedback.cjs');

const finding = (id, key, tag = 'v1.2.0') => ({ id, key, title: 'Agent skills tool', summary: 'MCP and skills', pinned: tag, signals: { releaseTag: tag }, verdict: 'watch', reasoning: { counter: 'overlap' } });

test('Wilson feedback is neutral without labels and rewards repeated implements', () => {
  const none = F.priors([], { mcp: 3 });
  assert.equal(none.multiplier(finding('x', 'gh:acme/tool')).multiplier, 1);
  const runs = [{ runId: '20261030-0800', findings: [finding('a', 'gh:acme/tool')] }];
  const decisions = { items: {
    a: { decision: 'implement', key: 'gh:acme/tool', runId: runs[0].runId, at: '2026-10-30T08:00:00Z' },
    b: { decision: 'implement', key: 'gh:acme/tool', at: '2026-10-30T09:00:00Z', title: 'MCP tool' },
    c: { decision: 'implement', key: 'gh:acme/tool', at: '2026-10-30T10:00:00Z', title: 'MCP tool' }
  } };
  assert.ok(F.priors(F.labels(decisions, runs), { mcp: 3 }).multiplier(finding('z', 'gh:acme/tool')).multiplier > 1.2);
});

test('dismissed projects stay suppressed until a higher minor or major release', () => {
  const decisions = { items: { a: { decision: 'dismiss', key: 'gh:acme/tool', version: 'v1.2.9', at: '2026-10-30T08:00:00Z' } } };
  const p = F.priors(F.labels(decisions, []), {});
  assert.equal(p.multiplier(finding('a', 'gh:acme/tool', 'v1.2.10')).multiplier, 0);
  assert.ok(p.multiplier(finding('b', 'gh:acme/tool', 'v1.3.0')).multiplier > 0);
});

test('priorVerdict returns the newest earlier verdict for a project', () => {
  const runs = [
    { runId: '20261029-0800', findings: [{ ...finding('a', 'gh:acme/tool'), verdict: 'skip', summary: 'old', reasoning: { counter: 'duplicate' } }] },
    { runId: '20261030-0800', findings: [{ ...finding('a', 'gh:acme/tool'), verdict: 'watch', summary: 'new', reasoning: { counter: 'young' } }] }
  ];
  assert.deepEqual(F.priorVerdict('gh:acme/tool', runs), { runId: '20261030-0800', verdict: 'watch', summary: 'new', counter: 'young' });
});
