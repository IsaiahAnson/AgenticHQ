'use strict';
// The email hint patterns in os-config.json are JSON strings, so a regex \b must be written \\b there.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'os-config.json'), 'utf8'));

test('email hint patterns hold no control characters', () => {
  for (const key of ['partnerHints', 'leadHints', 'personalFrom', 'hintSkipFrom']) {
    if (config[key] === undefined) continue;
    assert.doesNotMatch(String(config[key]), /[\u0000-\u001f]/, key);
  }
});

test('shipped partner and lead hints match sample subjects', () => {
  // server.js builds these with the "i" flag
  const partner = new RegExp(config.partnerHints, 'i'), lead = new RegExp(config.leadHints, 'i');
  for (const subject of ['Sponsorship opportunity', 'New partnership', 'Collab idea', 'Licence question']) assert.ok(partner.test(subject), subject);
  for (const subject of ['Quote request', 'Project inquiry', 'Next steps']) assert.ok(lead.test(subject), subject);
  assert.equal(partner.test('Weekly newsletter'), false);
  assert.equal(lead.test('Weekly newsletter'), false);
});
