'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { localStamp } = require('../lib/local-stamp.cjs');

test('report stamps use the local day and 24-hour time, not UTC', t => {
  const tz = process.env.TZ; process.env.TZ = 'America/New_York';
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  // 6:01 PM on Nov 1 in New York is 23:01 UTC, and 9:30 PM is already Nov 2 in UTC.
  assert.equal(localStamp(new Date('2026-11-01T23:01:00Z')), '20261101-1801');
  assert.equal(localStamp(new Date('2026-11-02T02:30:00Z')), '20261101-2130');
  // Daylight time, and a plain epoch number.
  assert.equal(localStamp(Date.parse('2026-07-04T13:05:00Z')), '20260704-0905');
});
