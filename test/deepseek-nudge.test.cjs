'use strict';
// DeepSeek sometimes ends a reply after one line ("I'll search across several categories in parallel…") with no
// [ref <nonce>] line, and deepseek-ask.ps1 exited 5, so AI Radar lost its sweep (2026-11-01, 8:26 and 8:29 PM).
// The script now nudges once in the same chat, but only when the page shows the reply finished and the last user
// message in the chat is ours. These run the real script against the fake orca (fixtures/radar/deepseek-ask-harness.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { skip, runAsk } = require('./fixtures/radar/deepseek-ask-harness.cjs');

const FIX = path.join(__dirname, 'fixtures', 'radar');
const REPLY = path.join(FIX, 'deepseek-utf8-reply.txt');
const PREAMBLE = path.join(FIX, 'deepseek-preamble-reply.txt');
const PROMPT = 'Sweep the web for new agent tools and reply with a JSON array.';
const opts = { skip, timeout: 180000 };
const lf = s => s.replace(/\r\n/g, '\n');
const nonceOf = s => (String(s).match(/\[ref ([0-9a-f]{8})\]/) || [])[1];

test('a finished reply with no [ref] line gets one nudge in the same chat, and the second reply is saved', opts, async t => {
  const { parseDeepseekReply } = await import('../tools/ai-radar.mjs');
  const { r, md, state } = runAsk(t, { prompt: PROMPT, env: { FAKE_ORCA_FIRST: PREAMBLE, FAKE_ORCA_REPLY: REPLY } });
  assert.equal(r.status, 0, `deepseek-ask exited ${r.status}: ${r.stderr}`);
  assert.equal(state.prompts.length, 2, 'the prompt plus one nudge');
  assert.equal(state.gotos, 1, 'only the -NewChat navigation: the nudge stays in the chat');
  assert.ok(nonceOf(state.prompts[0]), 'the prompt carries a [ref] nonce');
  assert.equal(nonceOf(state.prompts[1]), nonceOf(state.prompts[0]), 'the nudge asks for the same [ref] line');
  assert.equal(lf(parseDeepseekReply(md)), lf(fs.readFileSync(REPLY, 'utf8')).trim());
  assert.match(md, /^- Nudge: sent \(the first reply had no \[ref\] line: \d+ chars, "I'll search across/m, 'the reply file says a nudge was sent');
  assert.doesNotMatch(md, /Status: mismatch/);
});

test('no nudge while the reply is still being written', opts, async t => {
  const { r, md, state } = runAsk(t, { prompt: PROMPT, env: { FAKE_ORCA_FIRST: PREAMBLE, FAKE_ORCA_REPLY: REPLY, FAKE_ORCA_CHECK: '10' } });
  assert.equal(r.status, 5);
  assert.equal(state.prompts.length, 1);
  assert.match(md, /^- Nudge: skipped \(the reply is still being written\)$/m);
});

test('no nudge when the last user message in the chat is not ours', opts, async t => {
  const { r, md, state } = runAsk(t, { prompt: PROMPT, env: { FAKE_ORCA_FIRST: PREAMBLE, FAKE_ORCA_REPLY: REPLY, FAKE_ORCA_CHECK: '01' } });
  assert.equal(r.status, 5);
  assert.equal(state.prompts.length, 1);
  assert.match(md, /^- Nudge: skipped \(our \[ref\] is not in the last user message\)$/m);
});

test('only one nudge: a second reply with no [ref] line still exits 5', opts, async t => {
  const { r, state } = runAsk(t, { prompt: PROMPT, env: { FAKE_ORCA_FIRST: PREAMBLE, FAKE_ORCA_REPLY: REPLY, FAKE_ORCA_NONCE: 'never' } });
  assert.equal(r.status, 5);
  assert.equal(state.prompts.length, 2);
});
