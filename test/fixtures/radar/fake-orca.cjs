'use strict';
// Stands in for the orca CLI in the deepseek-ask.ps1 tests. fixtures/radar/deepseek-ask-harness.cjs hard-links node.exe
// as orca.exe and preloads this file through NODE_OPTIONS, so the script runs a real native command that prints UTF-8
// JSON, as orca does. It answers the script's orca calls; FAKE_ORCA_STATE keeps state between calls. One reply per
// message sent:
//   FAKE_ORCA_REPLY  the reply; it ends with the [ref] line the message asked for, as DeepSeek's does.
//   FAKE_ORCA_FIRST  optional first reply instead, with no [ref] line (DeepSeek stopping after "I'll search…").
//   FAKE_ORCA_NONCE  'never' leaves the [ref] line off every reply.
//   FAKE_ORCA_CHECK  the page check the script makes before a nudge: "the last user message is ours", then "the reply
//                    has finished", '1' or '0' each (default '11').
const fs = require('node:fs');
const path = require('node:path');

const verb = path.basename(process.argv[1] || '');
const rest = process.argv.slice(2);
const arg = name => rest[rest.indexOf(name) + 1];
const stateFile = process.env.FAKE_ORCA_STATE;
let state = { b64: '', prompt: '', prompts: [], gotos: 0 };
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { }

// The reply to the latest message sent.
function reply() {
  const n = state.prompts.length;
  if (n === 0) return '';
  if (n === 1 && process.env.FAKE_ORCA_FIRST) return fs.readFileSync(process.env.FAKE_ORCA_FIRST, 'utf8').trim();
  const text = fs.readFileSync(process.env.FAKE_ORCA_REPLY, 'utf8').trim();
  if (process.env.FAKE_ORCA_NONCE === 'never') return text;
  return `${text}\n[ref ${(state.prompts[n - 1].match(/\[ref ([0-9a-f]{8})\]/) || [])[1]}]`;
}

function evaluate(js) {
  if (js.includes('lastUser')) return process.env.FAKE_ORCA_CHECK || '11';
  if (js.includes('?1:0')) return '1';
  if (js.includes("__dsAsk=''")) { state.b64 = ''; return 'ok'; }
  const chunk = js.match(/__dsAsk\+='([^']*)'/);
  if (chunk) { state.b64 += chunk[1]; return 'ok'; }
  if (js.includes('atob(window.__dsAsk)')) { state.prompt = Buffer.from(state.b64, 'base64').toString('utf8'); return String(state.prompt.length); }
  if (js.includes("'clicked'")) { state.prompts.push(state.prompt); return 'clicked'; }
  if (js.includes('/a/chat/s/')) return '11';
  if (js.includes("'.ds-markdown').length")) return String(state.prompts.length);
  if (js.includes('innerText.length')) return String(reply().length);
  if (js.includes("innerText:''")) return reply();
  if (js.includes('a[href^=http]')) return 'https://github.com/inkeep/open-knowledge';
  if (js === 'location.href') return 'https://chat.deepseek.com/a/chat/s/fake-orca';
  return null;
}

let out = { ok: true, result: {} };
if (verb === 'tab' && rest[0] === 'list') out.result = { tabs: [{ url: 'https://chat.deepseek.com/', browserPageId: 'fake-page' }] };
else if (verb === 'eval') {
  const result = evaluate(arg('--expression'));
  out = result === null ? { ok: false } : { ok: true, result: { result } };
} else if (verb === 'goto') state.gotos++;
else if (!['tab', 'screenshot'].includes(verb)) out = { ok: false };
fs.writeFileSync(stateFile, JSON.stringify(state));
fs.writeSync(1, JSON.stringify(out) + '\n');
process.exit(out.ok ? 0 : 1);
