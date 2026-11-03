'use strict';
// Lead's grading tests for assets/hq-standings.js (spec hq-20261101-d-standings-ui.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const REPO = path.join(__dirname, '..');
const S = require(path.join(REPO, 'lib/standings.cjs'));
const H = require(path.join(REPO, 'assets/hq-standings.js'));

const AT1 = '2026-10-28T14:00:00Z', AT2 = '2026-10-30T23:02:00Z';
const mk = n => Array.from({ length: n }, (_, i) => ({ title: `Lesson number ${i} about topic${i} zeta${i}`, score: 90 - i * 3, reason: `why ${i}`, category: i % 2 ? 'odd' : 'even' }));
const store1 = () => S.mergeRun(S.emptyStore('learned'), mk(14), { runId: 'r1', at: AT1 });
const count = (s, re) => (s.match(re) || []).length;

test('movement covers every row of the table', () => {
  assert.deepEqual(H.movement({ rank: null, movement: null }), { cls: '', text: '', title: '' });
  assert.deepEqual(H.movement({ rank: 1, movement: 'new', delta: null }), { cls: 'hs-mv-new', text: 'NEW', title: 'New this run' });
  assert.deepEqual(H.movement({ rank: 1, movement: 'up', delta: 3 }), { cls: 'hs-mv-up', text: '▲3', title: 'Up 3 since last run' });
  assert.deepEqual(H.movement({ rank: 5, movement: 'down', delta: -2 }), { cls: 'hs-mv-down', text: '▼2', title: 'Down 2 since last run' });
  assert.deepEqual(H.movement({ rank: 2, movement: 'same', delta: 0 }), { cls: 'hs-mv-same', text: '–', title: 'Same spot as last run' });
  assert.deepEqual(H.movement({ rank: 2, movement: 'returned', delta: null }), { cls: 'hs-mv-back', text: '↺', title: 'Back in the standings' });
});

test('toolbar: board, search, five filters with counts, current one pressed', () => {
  let st = store1();
  const ids = Object.keys(st.items);
  st = S.setStatus(st, ids[0], 'approved'); st = S.setStatus(st, ids[1], 'done'); st = S.setStatus(st, ids[2], 'trashed');
  const out = H.html(S.view(st, { status: 'done' }), { status: 'done', query: 'abc' });
  assert.match(out, /^<div class="hs" data-board="learned">/);
  assert.match(out, /<input class="hs-q" type="search" value="abc" placeholder="Search all 14" aria-label="Search">/);
  const btns = out.match(/<button type="button" data-status="(ranked|approved|done|trashed|all)"[^>]*>[^<]*<\/button>/g);
  assert.equal(btns.length, 5);
  assert.match(btns[0], /data-status="ranked"[^>]*>Ranked 11</);
  assert.match(btns[1], />Approved 1</); assert.match(btns[2], /class="on"[^>]*aria-pressed="true">Done 1</);
  assert.match(btns[3], />Trashed 1</); assert.match(btns[4], />All 14</);
  assert.equal(count(out, /aria-pressed="true"/g), 1);
});

test('run line: 12-hour time, new and merged counts; "No runs yet" when empty', () => {
  const st = S.mergeRun(store1(), [...mk(3), { title: 'Fresh idea number one', score: 40 }], { runId: 'r2', at: AT2 });
  const out = H.html(S.view(st, { status: 'ranked' }));
  const m = /<span class="hs-run">Last run (\d{1,2}:\d{2}\s?[AP]M) · 1 new · 3 merged<\/span>/.exec(out);
  assert.ok(m, 'run line shape');
  assert.ok(!/23:02/.test(out), 'no 24-hour clock');
  const expected = new Date(AT2).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  assert.equal(m[1].replace(/\s/g, ' '), expected.replace(/\s/g, ' '));
  assert.match(H.html(S.view(S.emptyStore('radar'))), /<span class="hs-run">No runs yet<\/span>/);
});

test('tiers row only on the ranked filter, only non-empty tiers', () => {
  const st = store1();
  const ranked = H.html(S.view(st, { status: 'ranked' }), { status: 'ranked' });
  assert.match(ranked, /<div class="hs-tiers"><span class="hs-tc hs-t-S"><b>S<\/b> 3<\/span><span class="hs-tc hs-t-A"><b>A<\/b> 7<\/span><span class="hs-tc hs-t-B"><b>B<\/b> 4<\/span><\/div>/);
  assert.doesNotMatch(ranked, /hs-t-C"><b>C/);
  for (const status of ['all', 'open', 'approved', 'done', 'trashed']) assert.doesNotMatch(H.html(S.view(st, { status }), { status }), /hs-tiers/, status);
});

test('rows: rank, tier, NEW mark, meta; topOpen split with Show n more', () => {
  const out = H.html(S.view(store1(), { status: 'ranked' }), { topOpen: 5 });
  assert.equal(count(out, /<li class="hs-row hs-t-[SABCD]" data-id="[^"]+" tabindex="0">/g), 14);
  assert.match(out, /<span class="hs-rank">#1<\/span>\s*<span class="hs-tier">S<\/span>\s*<span class="hs-mv hs-mv-new" title="New this run">NEW<\/span>/);
  assert.match(out, /<details class="hs-rest"><summary>Show 9 more<\/summary><ol class="hs-list" start="6">/);
  const [top, rest] = out.split('<details class="hs-rest">');
  assert.equal(count(top, /class="hs-row /g), 5); assert.equal(count(rest, /class="hs-row /g), 9);
  assert.match(out, /<span class="hs-meta">score 90 · since Oct 28 · even<\/span>/);
  const ten = H.html(S.view(store1(), { status: 'ranked' }));
  assert.match(ten, /<summary>Show 4 more<\/summary><ol class="hs-list" start="11">/);
  const few = H.html(S.view(S.mergeRun(S.emptyStore('x'), mk(3), { runId: 'r1', at: AT1 })));
  assert.doesNotMatch(few, /hs-rest/);
});

test('second run that reorders shows up/down marks and seen count', () => {
  const st = S.mergeRun(S.mergeRun(S.emptyStore('x'), [{ title: 'Alpha alpha one', score: 90 }, { title: 'Beta beta two', score: 50 }], { runId: 'r1', at: AT1 }),
    [{ title: 'Alpha alpha one', score: 0 }, { title: 'Beta beta two', score: 100 }], { runId: 'r2', at: AT2 });
  const out = H.html(S.view(st, { status: 'ranked' }));
  assert.match(out, /<span class="hs-mv hs-mv-up" title="Up 1 since last run">▲1<\/span>/);
  assert.match(out, /<span class="hs-mv hs-mv-down" title="Down 1 since last run">▼1<\/span>/);
  assert.match(out, /seen ×2/);
});

test('escapes every item field and the query; detail() is the only raw HTML', () => {
  const evil = '<img src=x onerror=alert(1)>';
  let st = S.mergeRun(S.emptyStore('x'), [{ title: evil, score: 70, summary: `"sum" ${evil}`, reason: `r'${evil}`, category: `c&${evil}`, evidence: { text: `ev ${evil}`, source: `src ${evil}` } }], { runId: 'r1', at: AT1 });
  st = S.mergeRun(st, [{ title: `${evil} again`, score: 60 }], { runId: 'r2', at: AT2 });
  const id = Object.keys(st.items)[0];
  st = S.setStatus(st, id, 'approved', { note: `note ${evil}` });
  const out = H.html(S.view(st, { status: 'all' }), { status: 'all', query: `q"${evil}`, detail: () => '<em class="raw">ok</em>' });
  assert.ok(!out.includes('<img'), 'no raw img');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /value="q&quot;&lt;img/);
  assert.match(out, /r&#39;&lt;img|r&#x27;&lt;img/);
  assert.match(out, /c&amp;&lt;img/);
  assert.match(out, /note &lt;img/);
  assert.match(out, /<em class="raw">ok<\/em>/);
});

test('detail panel: summary, evidence list, aliases, status note, hidden by default', () => {
  let st = S.mergeRun(S.emptyStore('x'), [{ title: 'Cache the build output', score: 70, summary: 'Sum one', evidence: { text: 'ev one', source: 'log' } }], { runId: 'r1', at: AT1 });
  st = S.mergeRun(st, [{ title: 'Cache build outputs', score: 72, evidence: { text: 'ev two', source: 'run' } }], { runId: 'r2', at: AT2 });
  const id = Object.keys(st.items)[0];
  st = S.setStatus(st, id, 'done', { note: 'Shipped in abc123' });
  const out = H.html(S.view(st, { status: 'all' }), { status: 'all', labels: { done: 'Applied' } });
  assert.match(out, /<button type="button" class="hs-more" aria-expanded="false">Details<\/button>/);
  assert.match(out, /<div class="hs-detail" hidden>/);
  assert.match(out, /<ul class="hs-ev"><li>ev one <span>log · Oct 28<\/span><\/li><li>ev two <span>run · Oct 30<\/span><\/li><\/ul>/);
  assert.match(out, /Also seen as: Cache build outputs/);
  assert.match(out, /Shipped in abc123/);
  assert.match(out, /Sum one/);
  assert.match(out, /<span class="hs-st hs-st-done">Applied<\/span>/);
  assert.doesNotMatch(out, /hs-rank/);
});

test('default and custom actions; custom labels in filters and chips', () => {
  let st = S.mergeRun(S.emptyStore('x'), mk(2), { runId: 'r1', at: AT1 });
  const [a, b] = Object.keys(st.items);
  const out = H.html(S.view(st, { status: 'ranked' }));
  assert.match(out, new RegExp(`<button type="button" class="hs-act" data-id="${a}" data-status="approved">Approve</button><button type="button" class="hs-act" data-id="${a}" data-status="done">Done</button><button type="button" class="hs-act" data-id="${a}" data-status="trashed" data-confirm="1">Trash</button>`));
  st = S.setStatus(st, b, 'trashed');
  const all = H.html(S.view(st, { status: 'all' }), { status: 'all', labels: { done: 'Applied', trashed: 'Dismissed' } });
  assert.match(all, new RegExp(`data-id="${b}" data-status="open">Reopen</button>`));
  assert.match(all, /<span class="hs-st hs-st-trashed">Dismissed<\/span>/);
  assert.match(all, />Applied 0</); assert.match(all, />Dismissed 1</);
  const custom = H.html(S.view(st, { status: 'ranked' }), { actions: it => [{ status: 'done', label: `Apply ${it.rank}`, confirm: true }] });
  assert.match(custom, new RegExp(`data-id="${a}" data-status="done" data-confirm="1">Apply 1</button>`));
  assert.doesNotMatch(custom, />Approve</);
});

test('empty state replaces the lists', () => {
  const out = H.html(S.view(S.emptyStore('demo')), { emptyText: 'No moves yet.' });
  assert.match(out, /<p class="hs-empty">No moves yet\.<\/p>/);
  assert.doesNotMatch(out, /hs-list/);
  assert.match(H.html(S.view(S.emptyStore('demo'))), /<p class="hs-empty">Nothing here yet\.<\/p>/);
});

test('html is pure and does not mutate the view', () => {
  const v = S.view(store1(), { status: 'ranked' }), snap = JSON.stringify(v);
  assert.equal(H.html(v, { topOpen: 4 }), H.html(v, { topOpen: 4 }));
  assert.equal(JSON.stringify(v), snap);
});

// --- wire() against a small fake DOM ---
function fakeDom(markup) {
  const listeners = {};
  const el = (props) => {
    const e = Object.assign({ dataset: {}, disabled: false, textContent: '', hidden: false, attrs: {}, cls: new Set(), parent: null }, props);
    e.classList = { add: c => e.cls.add(c), remove: c => e.cls.delete(c), contains: c => e.cls.has(c) };
    e.setAttribute = (k, v) => { e.attrs[k] = String(v); };
    e.getAttribute = k => e.attrs[k];
    e.matches = sel => sel.split(',').some(s => {
      s = s.trim();
      if (s === '.hs-act') return e.cls.has('hs-act');
      if (s === '.hs-more') return e.cls.has('hs-more');
      if (s === '.hs-row') return e.cls.has('hs-row');
      if (s === '.hs-q') return e.cls.has('hs-q');
      if (s === '.hs-filter button') return e.tag === 'button' && e.parent && e.parent.cls.has('hs-filter');
      return false;
    });
    e.closest = sel => { for (let n = e; n; n = n.parent) if (n.matches(sel)) return n; return null; };
    return e;
  };
  const root = el({ tag: 'div' });
  root.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  root.contains = n => { for (let x = n; x; x = x.parent) if (x === root) return true; return false; };
  const filter = el({ tag: 'div', parent: root }); filter.cls.add('hs-filter');
  const fOn = el({ tag: 'button', parent: filter, dataset: { status: 'ranked' } }); fOn.cls.add('on');
  const fDone = el({ tag: 'button', parent: filter, dataset: { status: 'done' } });
  const q = el({ tag: 'input', parent: root, value: 'abc' }); q.cls.add('hs-q');
  const row = el({ tag: 'li', parent: root }); row.cls.add('hs-row');
  const act = el({ tag: 'button', parent: row, dataset: { id: 'i1', status: 'approved' }, textContent: 'Approve' }); act.cls.add('hs-act');
  const trash = el({ tag: 'button', parent: row, dataset: { id: 'i1', status: 'trashed', confirm: '1' }, textContent: 'Trash' }); trash.cls.add('hs-act');
  const more = el({ tag: 'button', parent: row, attrs: { 'aria-expanded': 'false' } }); more.cls.add('hs-more');
  const detail = el({ tag: 'div', parent: row, hidden: true }); detail.cls.add('hs-detail');
  const byClass = { '.hs-q': q, '.hs-filter button.on': fOn, '.hs-detail': detail, '.hs-more': more };
  root.querySelector = sel => byClass[sel] || null;
  row.querySelector = sel => byClass[sel] || null;
  const fire = (type, target, extra = {}) => (listeners[type] || []).forEach(fn => fn({ type, target, preventDefault() {}, ...extra }));
  return { root, listeners, fire, fOn, fDone, q, row, act, trash, more, detail };
}

test('wire: actions, confirm arming, details toggle, filters, debounced search, no stacking', async () => {
  const d = fakeDom();
  const calls = [];
  let resolveAct;
  H.wire(d.root, { onAction: (id, status, btn) => { calls.push(['act', id, status]); return new Promise(r => { resolveAct = r; }); }, onFilter: f => calls.push(['filter', f]) });
  H.wire(d.root, { onAction: (id, status) => { calls.push(['act2', id, status]); return new Promise(r => { resolveAct = r; }); }, onFilter: f => calls.push(['filter2', f]) });
  assert.equal(d.listeners.click.length, 1, 'click listener not stacked');
  d.fire('click', d.act);
  assert.deepEqual(calls.at(-1), ['act2', 'i1', 'approved'], 'latest handlers used');
  assert.equal(d.act.disabled, true, 'disabled while pending');
  resolveAct(); await new Promise(r => setTimeout(r, 10));
  assert.equal(d.act.disabled, false, 're-enabled after promise');
  const before = calls.length;
  d.fire('click', d.trash);
  assert.equal(calls.length, before, 'first click only arms');
  assert.ok(d.trash.classList.contains('arm')); assert.equal(d.trash.textContent, 'Sure?');
  d.fire('click', d.trash);
  assert.deepEqual(calls.at(-1), ['act2', 'i1', 'trashed']);
  resolveAct();
  d.fire('click', d.more);
  assert.equal(d.detail.hidden, false); assert.equal(d.more.getAttribute('aria-expanded'), 'true');
  d.fire('keydown', d.row, { key: 'Enter' });
  assert.equal(d.detail.hidden, true);
  d.fire('click', d.fDone);
  assert.deepEqual(calls.at(-1), ['filter2', { query: 'abc', status: 'done' }]);
  d.q.value = 'zeta'; d.fire('input', d.q); d.q.value = 'zeta9'; d.fire('input', d.q);
  const n = calls.length;
  await new Promise(r => setTimeout(r, 120));
  assert.equal(calls.length, n, 'debounced');
  await new Promise(r => setTimeout(r, 220));
  assert.deepEqual(calls.at(-1), ['filter2', { query: 'zeta9', status: 'ranked' }]);
  assert.equal(calls.filter(c => c[0] === 'filter2' && c[1].query.startsWith('zeta')).length, 1);
});

test('confirm arming reverts after 3 seconds', { timeout: 6000 }, async () => {
  const d = fakeDom();
  H.wire(d.root, { onAction: () => {}, onFilter: () => {} });
  d.fire('click', d.trash);
  assert.equal(d.trash.textContent, 'Sure?');
  await new Promise(r => setTimeout(r, 3150));
  assert.ok(!d.trash.classList.contains('arm')); assert.equal(d.trash.textContent, 'Trash');
});
