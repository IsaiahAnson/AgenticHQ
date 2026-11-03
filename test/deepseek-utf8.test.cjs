'use strict';
// DeepSeek text must reach Radar as UTF-8. Windows PowerShell decodes a native command's output with
// [Console]::OutputEncoding, and the hidden console Radar starts deepseek-ask.ps1 in uses code page 437, so an em dash
// was stored as "ΓÇö" (found 2026-11-01). This runs the real script the way runDeepseek does against a fake orca that
// prints UTF-8 (fixtures/radar/deepseek-ask-harness.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const R = require('../lib/radar-score.cjs');
const { skip, runAsk } = require('./fixtures/radar/deepseek-ask-harness.cjs');

const REPLY = path.join(__dirname, 'fixtures', 'radar', 'deepseek-utf8-reply.txt');
const lf = s => s.replace(/\r\n/g, '\n');

test('deepseek-ask.ps1 keeps em dashes, curly quotes and ellipses from orca', { skip, timeout: 180000 }, async t => {
  const { parseDeepseekReply } = await import('../tools/ai-radar.mjs');
  const { r, md, state } = runAsk(t, { prompt: 'List new tools — “agent” repos only…', env: { FAKE_ORCA_REPLY: REPLY } });
  assert.equal(r.status, 0, `deepseek-ask exited ${r.status}: ${r.stderr || r.error}`);

  assert.doesNotMatch(md, /ΓÇ|┬/, 'CP437 mojibake in the reply file');
  assert.match(md, /- Chat URL: https:\/\/chat\.deepseek\.com\/a\/chat\/s\/fake-orca/);
  const answer = parseDeepseekReply(md);
  assert.equal(lf(answer), lf(fs.readFileSync(REPLY, 'utf8')).trim());
  const [item] = R.extractJson(answer);
  assert.equal(item.title, 'OpenKnowledge — agent-native “markdown” wiki with MCP…');
  assert.equal(item.why, 'It’s a wiki agents can edit · skills included');
  // The prompt goes the other way (file, base64, TextDecoder in the page) and was already UTF-8; keep it that way.
  assert.match(state.prompt, /^List new tools — “agent” repos only…/);
});
