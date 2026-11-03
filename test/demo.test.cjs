'use strict';
// Demo mode (lib/demo.cjs): time tokens, fixture lookup and the read-only request handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const demo = require('../lib/demo.cjs');

const NOW = new Date(2026, 10, 2, 21, 30, 15);   /* Mon 2 Nov 2026, 9:30:15 PM local */

test('time tokens resolve against now in every format', () => {
  const t = s => demo.tokenValue(s, NOW);
  assert.equal(t('@iso:0'), NOW.toISOString());
  assert.equal(t('@iso:'), NOW.toISOString());
  assert.equal(t('@ms:-2h15m'), NOW.getTime() - (2 * 60 + 15) * 60e3);
  assert.equal(t('@s:+30s'), Math.floor(NOW.getTime() / 1000) + 30);
  assert.equal(t('@date:-6d'), '2026-10-27');
  assert.equal(t('@hm:0d@07:05'), '07:05');
  assert.equal(t('@iso:-1d@09:00'), new Date(2026, 10, 1, 9, 0, 0).toISOString());
  assert.equal(t('@ms:+2d@14:30'), new Date(2026, 10, 4, 14, 30, 0).getTime());
});

test('anything that is not a whole token stays as written', () => {
  for (const s of ['@iso:soon', '@when:0', 'ran @hm:0', '@iso:1d+2h', 'email@example.com']) assert.equal(demo.tokenValue(s, NOW), s);
  assert.deepEqual(demo.resolve({ a: ['@date:0', 3, null, { b: '@hm:-30m' }], c: 'plain' }, NOW), { a: ['2026-11-02', 3, null, { b: '21:00' }], c: 'plain' });
});

test('script fixtures resolve quoted tokens; epoch formats lose their quotes', () => {
  assert.equal(demo.resolveScript(`window.X={at:"@date:0",n:'@ms:0',keep:"@nope:1"};`, NOW),
    `window.X={at:"2026-11-02",n:${NOW.getTime()},keep:"@nope:1"};`);
});

const made = [];
process.on('exit', () => made.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixtures(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-demo-'));
  made.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('a path maps to its fixture, and the most specific matching variant wins', () => {
  const dir = fixtures({ 'learned.standings.json': {}, 'learned.standings@status=all.json': {}, 'learned.standings@status=all&limit=5.json': {}, 'calendar.json': {} });
  const f = (p, q = '') => { const hit = demo.fixtureFile(dir, p, new URLSearchParams(q)); return hit && path.basename(hit); };
  assert.equal(f('/api/calendar'), 'calendar.json');
  assert.equal(f('/api/learned/standings'), 'learned.standings.json');
  assert.equal(f('/api/learned/standings', 'status=ranked'), 'learned.standings.json');
  assert.equal(f('/api/learned/standings', 'status=all'), 'learned.standings@status=all.json');
  assert.equal(f('/api/learned/standings', 'limit=5&status=all'), 'learned.standings@status=all&limit=5.json');
  assert.equal(f('/api/nothing'), null);
  assert.equal(f('/api/../calendar'), null);
});

test('the handler answers feeds from fixtures, refuses writes and leaves real routes alone', async () => {
  const dir = fixtures({ 'today.json': { at: '@date:0' }, 'data/arms-usage.js': 'window.ARMS_USAGE={at:"@ms:0"};' });
  const out = [];
  const d = demo.create({ kit: dir, dir, sendJson: (res, body, code = 200) => out.push({ code, body }), sendScript: (res, text) => out.push({ code: 200, text }) });
  const call = (method, url) => { const u = new URL(url, 'http://localhost'); return d.handle({ method }, {}, { p2: u.pathname, u, post: method === 'POST' }); };

  assert.equal(await call('GET', '/api/today'), true);
  assert.equal(out.pop().body.at, demo.resolve('@date:0'));
  assert.equal(await call('GET', '/api/mail-secrets'), true);
  assert.deepEqual(out.pop(), { code: 404, body: { error: 'not in the demo' } });
  assert.equal(await call('POST', '/api/open'), true);
  assert.deepEqual(out.pop(), { code: 403, body: { error: 'The demo is read-only.' } });
  assert.equal(await call('GET', '/data/arms-usage.js'), true);
  assert.match(out.pop().text, /^window\.ARMS_USAGE=\{at:\d+\};$/);

  for (const real of ['/api/artifacts', '/api/addons', '/local/boot', '/local/search', '/data/snapshot.js', '/os.html', '/artifacts/x.html']) assert.equal(await call('GET', real), false, real);
  assert.equal(out.length, 0);
  assert.deepEqual(d.feed('/api/today'), { at: demo.resolve('@date:0') });
  assert.equal(d.feed('/api/stats'), null);
});
