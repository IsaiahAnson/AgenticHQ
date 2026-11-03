const assert = require('node:assert/strict');
const test = require('node:test');

async function subject() { return import('../tools/hq-doctor.mjs'); }

test('pure summary returns the highest severity exit code', async () => {
  const { summarizeChecks } = await subject();
  assert.equal(summarizeChecks([{ status: 'pass', check: 'a', detail: 'ok' }]).exitCode, 0);
  assert.equal(summarizeChecks([{ status: 'pass', check: 'a', detail: 'ok' }, { status: 'warn', check: 'b', detail: 'old' }]).exitCode, 1);
  assert.equal(summarizeChecks([{ status: 'warn', check: 'b', detail: 'old' }, { status: 'fail', check: 'c', detail: 'down' }]).exitCode, 2);
});

test('unknown statuses fail closed', async () => {
  const { summarizeChecks } = await subject();
  const summary = summarizeChecks([{ status: 'mystery', check: 'x', detail: 'unknown' }]);
  assert.equal(summary.rows[0].status, 'fail');
  assert.equal(summary.exitCode, 2);
});

test('table includes exactly one header and every check row', async () => {
  const { formatTable } = await subject();
  const table = formatTable([{ status: 'pass', check: 'health', detail: 'ready' }, { status: 'warn', check: 'git', detail: '2 dirty' }]);
  assert.equal((table.match(/STATUS/g) || []).length, 1);
  assert.match(table, /PASS\s+health\s+ready/);
  assert.match(table, /WARN\s+git\s+2 dirty/);
});
