const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'radar.html'), 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);

test('radar loads the shared standings assets and its inline script parses', () => {
  assert.match(html, /<link rel="stylesheet" href="assets\/hq-standings\.css">/);
  assert.match(html, /<script src="assets\/hq-standings\.js"><\/script>/);
  assert.equal(inline.length, 1);
  assert.doesNotThrow(() => new vm.Script(inline[0]));
});

test('standings requests support filters, search, and the this-scan toggle', () => {
  assert.match(html, /new URLSearchParams\(\{ status: f\.status, limit: '500' \}\)/);
  assert.match(html, /params\.set\('q', f\.query\)/);
  assert.match(html, /params\.set\('run', 'latest'\)/);
  assert.match(html, /id="thisScan"[^>]+aria-pressed="false"/);
});

test('a missing standings route retains the latest-only fallback', () => {
  assert.match(html, /catch \(e\) \{ state\.standings = null; state\.standingsError = e\.message; \}/);
  assert.match(html, /if \(state\.view === 'find'\) \{ if \(!board\) renderList\(\); \}/);
  assert.match(html, /function findings\(\) \{ return state\.oldRun \? arr\(state\.oldRun\.findings\) : arr\(state\.data\?\.latest\?\.findings\); \}/);
});

test('standings actions preserve implement and merge while syncing status', () => {
  assert.match(html, /\{ status: 'implement', label: 'Implement', confirm: true \}/);
  assert.match(html, /\{ status: 'trashed', label: 'Dismiss', confirm: true \}/);
  assert.match(html, /item\.status === 'approved' && state\.jobs\[f\.id\]\?\.canMerge/);
  assert.match(html, /api\('\/status', \{ id, status \}\)/);
  assert.match(html, /if \(action === 'implement'\) return implement\(f\)/);
  assert.match(html, /if \(action === 'merge'\) return merge\(f\.id\)/);
});

test('standings detail covers the required fields and routes nested build actions by finding id', () => {
  for (const label of ['Verdict', 'Confidence', 'Effort', 'Plan', 'Risks', 'Critique', 'Sources and links']) assert.match(html, new RegExp(label));
  assert.match(html, /data-finding-id="\$\{esc\(f\.id\)\}"/);
  assert.match(html, /a\.closest\('\[data-finding-id\]'\)\?\.dataset\.findingId/);
});
