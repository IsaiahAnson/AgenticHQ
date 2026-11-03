'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readDrafts, waitingDrafts } = require('../lib/email-drafts.cjs');

const NOW = Date.parse('2026-10-29T12:00:00Z');
const entry = (draftId, threadId, created, extra = {}) => ({
  threadId, draftId, subject: 'Re: ' + draftId, from: 'Dana Okafor <dana@example.com>', why: 'Asked for the invoice', created, ...extra
});

test('drafts.json maps to subject, from name, why and a Gmail thread link, newest first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-drafts-'));
  const file = path.join(dir, 'drafts.json');
  fs.writeFileSync(file, JSON.stringify([entry('r1', 't1', '2026-10-28T10:00:00Z'), entry('r2', 't2', '2026-10-29T06:00:00Z')]));
  const out = waitingDrafts(readDrafts(file), new Set(['r1', 'r2']), NOW);
  assert.deepEqual(out.map(d => d.subject), ['Re: r2', 'Re: r1']);
  assert.deepEqual(out[0], { subject: 'Re: r2', from: 'Dana Okafor', why: 'Asked for the invoice', created: '2026-10-29T06:00:00Z', link: 'https://mail.google.com/mail/u/0/#all/t2' });
});

test('a draft he sent or deleted is no longer in Gmail and drops off', () => {
  const out = waitingDrafts([entry('r1', 't1', '2026-10-29T06:00:00Z'), entry('r2', 't2', '2026-10-29T06:00:00Z')], new Set(['r2']), NOW);
  assert.deepEqual(out.map(d => d.link), ['https://mail.google.com/mail/u/0/#all/t2']);
});

test('a live draft stays even when older than 7 days', () => {
  assert.equal(waitingDrafts([entry('r1', 't1', '2026-10-01T06:00:00Z')], new Set(['r1']), NOW).length, 1);
});

test('when Gmail cannot be asked, entries older than 7 days drop', () => {
  const out = waitingDrafts([entry('r1', 't1', '2026-10-21T11:00:00Z'), entry('r2', 't2', '2026-10-25T06:00:00Z')], null, NOW);
  assert.deepEqual(out.map(d => d.subject), ['Re: r2']);
});

test('missing or broken drafts.json and bad thread ids give nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-drafts-'));
  assert.deepEqual(readDrafts(path.join(dir, 'none.json')), []);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
  assert.deepEqual(readDrafts(path.join(dir, 'bad.json')), []);
  assert.deepEqual(waitingDrafts([entry('r1', 'x/../y', '2026-10-29T06:00:00Z'), { threadId: 't' }], null, NOW), []);
});
