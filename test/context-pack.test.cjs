'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { qmdAllowed, synthesizeContext } = require('../lib/context-pack.cjs');

test('only the curated knowledge folder and top-level HQ guides are eligible for API synthesis', () => {
  assert.equal(qmdAllowed(path.join(process.env.RUBRIC_KNOWLEDGE_DIR || path.join(require('../lib/places.cjs').companions, 'knowledge'), 'MEMORY.md')), true);
  assert.equal(qmdAllowed(path.join(__dirname, '..', 'WIRING.md')), true);
  assert.equal(qmdAllowed(path.join(__dirname, '..', 'engine', 'secret.md')), false);
  assert.equal(qmdAllowed(path.join(os.homedir(), 'Documents', 'private.md')), false);
});

test('Claude synthesis sends curated excerpts and excludes other workspace files', async () => {
  const pack = { task: 'Explain HQ', sources: [
    { id: 'S1', path: 'WIRING.md', modifiedAt: '2026-10-27T00:00:00Z', text: 'Allowed guide text', apiAllowed: true },
    { id: 'S2', path: 'private.py', modifiedAt: '2026-10-27T00:00:00Z', text: 'Sensitive workspace text', apiAllowed: false }
  ] };
  let sent;
  const fetchImpl = async (_url, options) => {
    sent = options.body;
    return { ok: true, json: async () => ({ model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'HQ uses a guide [S1].' }] }) };
  };
  const result = await synthesizeContext(pack, 'synthetic-key', fetchImpl);
  assert.match(sent, /Allowed guide text/);
  assert.doesNotMatch(sent, /Sensitive workspace text/);
  assert.deepEqual(result.sourceIds, ['S1']);
});
