'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('fresh usage reads keep their source-specific polling floors', () => {
  assert.match(source, /if \(cachePending\.has\(key\)\) return cachePending\.get\(key\)/);
  assert.match(source, /localUsage\.read\(\{ fresh \}\)/);
  assert.match(source, /cached\('claudeApiOrg', fresh \? 60000 : 5 \* 60000, read\)/);
  const meters = fs.readFileSync(path.join(__dirname, '..', 'lib', 'usage-meters.cjs'), 'utf8');
  assert.match(meters, /cached\('herder', 60000/);
  assert.match(meters, /cached\('copilot', 10 \* MINUTE/);
});

