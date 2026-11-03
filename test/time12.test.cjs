/* assets/time12.js: every clock time HQ shows a person is 12-hour. First draft of these cases by DeepSeek web (2026-10-29). */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/time12.js');

const tz = 'America/New_York';
const instant = '2024-10-29T21:42:00Z';   /* Tue Oct 29 2024, 17:42 EDT */

test('time formats instants in 12-hour form', () => {
  assert.equal(T.time(instant, { tz }), '5:42 PM');
  assert.equal(T.time('2024-10-29T09:05:00Z', { tz, seconds: true }), '5:05:00 AM');
  assert.equal(T.time(Date.parse(instant), { tz }), '5:42 PM');
  assert.equal(T.time('not-a-date', { tz }), '');
  assert.equal(T.time(null, { tz }), '');
});

test('dateTime shapes', () => {
  assert.equal(T.dateTime(instant, { tz }), 'Oct 29, 5:42 PM');
  assert.equal(T.dateTime(instant, { tz, weekday: true }), 'Tue 5:42 PM');
  assert.equal(T.dateTime(instant, { tz, weekday: true, date: true }), 'Tue, Oct 29, 5:42 PM');
  assert.equal(T.dateTime(instant, { tz, year: true }), 'Oct 29, 2024, 5:42 PM');
  assert.equal(T.dateTime(instant, { tz, date: false }), '5:42 PM');
  assert.equal(T.dateTime(undefined, { tz }), '');
});

test('hm converts "HH:MM" and minutes after midnight, leaves the rest alone', () => {
  assert.equal(T.hm('21:42'), '9:42 PM');
  assert.equal(T.hm('07:00'), '7:00 AM');
  assert.equal(T.hm(1302), '9:42 PM');
  assert.equal(T.hm('00:00'), '12:00 AM');
  assert.equal(T.hm('12:30'), '12:30 PM');
  assert.equal(T.hm(1302.5), 1302.5);
  assert.equal(T.hm(-1), -1);
  assert.equal(T.hm('soon'), 'soon');
});

test('text rewrites zero-padded 24-hour times in display strings', () => {
  assert.equal(T.text('daily at 07:00, 21:42'), 'daily at 7:00 AM, 9:42 PM');
  assert.equal(T.text('Mon, Wed at 12:30'), 'Mon, Wed at 12:30 PM');
});

test('text leaves machine and ambiguous strings alone', () => {
  for (const s of ['1:02:03', 'T21:42', 't21:42', '9:42 pm', '9:42 p.m.', '09:42  PM', '09:42 p. m.', 'v1.12:30', 'v1:12',
    'localhost:50000', 'score 3:45', '1:02.5', 'UTC+05:30', '13:45/14:56', '2024-10-29T21:42:00Z'])
    assert.equal(T.text(s), s);
});

test('cron reads as days and 12-hour times', () => {
  assert.equal(T.cron('cron 0 22 * * *'), 'daily · 10:00 PM');
  assert.equal(T.cron('cron 15 8 * * *'), 'daily · 8:15 AM');
  assert.equal(T.cron('0 9,18 * * 1-5'), 'weekdays · 9:00 AM & 6:00 PM');
  assert.equal(T.cron('cron */5 * * * *'), 'cron */5 * * * *');
  assert.equal(T.cron('On demand'), 'On demand');
});
