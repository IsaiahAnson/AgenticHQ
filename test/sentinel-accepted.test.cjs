'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { apply, accept, unaccept, load } = require('../lib/sentinel-accepted.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-acc-')), 'accepted.json');
const pagefile = mb => ({ id: 'pagefile', ok: mb <= 32768, summary: `Page file ${Math.round(mb / 1024)} GB`, data: { value: mb, worse: 'higher' } });
const disk = gb => ({ id: 'disk-c', ok: gb >= 50, summary: `C: ${gb} GB free`, data: { value: gb, worse: 'lower' } });

test('accepted failing check turns ok and is marked accepted', () => {
  const file = tmp();
  accept('pagefile', { ok: false, data: { value: 73216, worse: 'higher' } }, 'seen it', file);
  const [r] = apply([pagefile(73216)], load(file));
  assert.equal(r.ok, true); assert.equal(r.accepted, true); assert.match(r.summary, /\[accepted\]/);
});

test('small growth stays accepted, more than 10% worse fails again', () => {
  const all = { pagefile: { value: 70000, worse: 'higher' }, 'disk-c': { value: 40, worse: 'lower' } };
  assert.equal(apply([pagefile(76000)], all)[0].ok, true);
  const [worse] = apply([pagefile(78000)], all);
  assert.equal(worse.ok, false); assert.match(worse.summary, /was accepted at 70000/);
  assert.equal(apply([disk(37)], all)[0].ok, true);
  assert.equal(apply([disk(35)], all)[0].ok, false);
});

test('healthy and unaccepted checks pass through unchanged', () => {
  const ok = pagefile(16000), bad = disk(20);
  assert.deepEqual(apply([ok, bad], {}), [ok, bad]);
});

test('unaccept restores the warning', () => {
  const file = tmp();
  accept('pagefile', { ok: false, data: { value: 73216, worse: 'higher' } }, '', file);
  unaccept('pagefile', file);
  assert.equal(apply([pagefile(73216)], load(file))[0].ok, false);
});

test('unknown or unmeasured check ids are rejected', () => {
  const file = tmp();
  assert.throws(() => accept('nope', undefined, '', file), /unknown check/);
  assert.throws(() => accept('edge-leak', { ok: true, data: null }, '', file), /no measured value/);
  assert.throws(() => unaccept('pagefile', file), /not accepted/);
});
