'use strict';

// Lints the real failure registry: a split or short row would be silently dropped from Gotcha Proposals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRegistry } = require('../lib/gotcha-proposals.cjs');

const REGISTRY = path.join(require('../lib/places.cjs').companions, 'knowledge', 'hq-failure-registry.md');
const STATUSES = new Set(['proposed', 'active', 'fixed', 'watching', 'resolved', 'rejected', 'retired', 'superseded']);

test('every failure-registry row is a whole table row with a known status', { skip: !fs.existsSync(REGISTRY) && 'registry not on this PC' }, () => {
  const warnings = [];
  parseRegistry(REGISTRY, { onWarning: message => warnings.push(message) });
  assert.deepEqual(warnings, []);
  const rows = fs.readFileSync(REGISTRY, 'utf8').split(/\r?\n/).filter(line => /^\|\s*`/.test(line));
  assert.ok(rows.length > 0);
  for (const line of rows) {
    const status = line.split('|').slice(1, -1).map(cell => cell.trim())[8];
    assert.ok(STATUSES.has(status.toLowerCase()), `unknown status "${status}" in: ${line.slice(0, 60)}`);
  }
});
