'use strict';
// The homepage layout key must never be renamed: a new name throws away every saved layout.
// New widgets join saved layouts through os.html's DEFLAY merge instead (see the 2026-10-28 v11-v13 incident).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('os.html keeps the os-dash-v10-hq layout key', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'os.html'), 'utf8');
  assert.match(html, /const LAYKEY = 'os-dash-v10-hq';/);
});
