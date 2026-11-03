'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildContentIndex, searchContent } = require('../engine/content-search.cjs');
const { topicsFor } = require('../lib/context-authority.cjs');

test('content search finds lines inside mapped files and excludes secret or generated files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-context-search-'));
  t.after(() => { if (root.startsWith(os.tmpdir() + path.sep)) fs.rmSync(root, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'Projects'));
  fs.mkdirSync(path.join(root, 'Projects', 'data'));
  const files = [
    ['Projects/guide.md', 'The runner starts a Skills Deck card.'],
    ['Projects/credentials.md', 'runner secret'],
    ['Projects/data/cache.md', 'runner generated'],
    ['Projects/other.md', 'Nothing relevant.']
  ];
  for (const [rel, body] of files) { const file = path.join(root, rel); fs.writeFileSync(file, body); }
  const model = { files: files.map(([rel, body]) => ({ rel, ext: path.extname(rel), size: Buffer.byteLength(body), mtime: Date.now() })) };
  const index = buildContentIndex(model, root);
  const results = searchContent(index, 'How does runner start a Skills Deck card?');
  assert.equal(index.coverage.indexed, 2);
  assert.deepEqual(results.map(r => r.path), ['Projects/guide.md']);
  assert.equal(results[0].line, 1);
});

test('runner task names canonical sources and live checks', () => {
  const runner = topicsFor('How does the Skills Deck card run?').find(x => x.id === 'runner');
  assert.ok(runner);
  assert.ok(runner.canonical.some(x => x.path.endsWith('server.js') && x.exists));
  assert.ok(runner.live.includes('/api/skills'));
});
