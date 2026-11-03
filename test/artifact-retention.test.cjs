const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

async function subject() { return import('../tools/artifact-retention.mjs'); }
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-retention-')); roots.push(root); fs.mkdirSync(path.join(root, '_trash')); return root; }
function write(root, name, ageDays = 0) { const file = path.join(root, name); fs.writeFileSync(file, name); const at = new Date(Date.now() - ageDays * 86400000); fs.utimesSync(file, at, at); return file; }

test('recognizes timestamped report families but not canonical pages', async () => {
  const { stampedReport } = await subject();
  assert.equal(stampedReport('agent-monitor.html'), null);
  assert.equal(stampedReport('gotcha-proposals-20261029-1900.html').family, 'gotcha-proposals:run');
  assert.equal(stampedReport('gotcha-proposals-2026-10-29.html').family, 'gotcha-proposals:daily');
});

test('daily and run pages are retained as separate families', async () => {
  const root = fixture();
  write(root, 'gotcha-proposals-20261101-1900.html'); write(root, 'gotcha-proposals-2026-11-01.html');
  const { planRetention } = await subject();
  assert.deepEqual(planRetention(root).moves, []);
});

test('keeps newest family page and moves older page with sidecar', async () => {
  const root = fixture();
  for (const ext of ['html', 'json']) { write(root, `report-20261028-1900.${ext}`); write(root, `report-20261029-1900.${ext}`); }
  write(root, 'canonical.html');
  const { planRetention, applyRetention } = await subject();
  const plan = planRetention(root);
  assert.deepEqual(plan.moves.map(x => path.basename(x.source)).sort(), ['report-20261028-1900.html', 'report-20261028-1900.json']);
  applyRetention(plan);
  assert.equal(fs.existsSync(path.join(root, 'report-20261029-1900.html')), true);
  assert.equal(fs.existsSync(path.join(root, 'canonical.html')), true);
  assert.equal(fs.existsSync(path.join(root, '_trash', 'report-20261028-1900.json')), true);
});

test('deletes only stamped trash pairs older than 30 days', async () => {
  const root = fixture();
  for (const ext of ['html', 'json']) write(path.join(root, '_trash'), `old-20260101-1200.${ext}`, 31);
  write(path.join(root, '_trash'), 'canonical.html', 60);
  const { planRetention, applyRetention } = await subject();
  const plan = planRetention(root);
  assert.equal(plan.deletes.length, 2);
  applyRetention(plan);
  assert.equal(fs.existsSync(path.join(root, '_trash', 'old-20260101-1200.html')), false);
  assert.equal(fs.existsSync(path.join(root, '_trash', 'canonical.html')), true);
});
