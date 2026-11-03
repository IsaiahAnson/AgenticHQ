'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/standings.cjs');
const H = require('../assets/hq-standings.js');

const at = '2026-10-30T23:02:00Z';
const candidates = [
  { title: 'Alpha engine', score: 90, reason: 'Strong', summary: 'Summary', category: 'Tools', evidence: { text: 'Evidence', source: 'Log' } },
  { title: 'Beta toolkit', score: 30 }
];
const make = (items = candidates) => S.mergeRun(S.emptyStore('learned'), items, { runId: 'r1', at });
const render = (store, opts = {}) => H.html(S.view(store, { status: opts.status || 'ranked', query: opts.query || '' }), opts);

test('ranked view renders non-empty tier counts and new movement', () => {
  const out = render(make());
  assert.match(out, /class="hs-tiers"/);
  assert.match(out, /class="hs-tc hs-t-S"><b>S<\/b> 2/);
  assert.match(out, /class="hs-rank">#1/);
  assert.match(out, /class="hs-tier">S/);
  assert.equal((out.match(/hs-mv-new/g) || []).length, 2);
  assert.match(out, /title="New this run">NEW/);
});

test('non-ranked filters omit tiers while retaining rows', () => {
  const out = render(make(), { status: 'all' });
  assert.doesNotMatch(out, /class="hs-tiers"/);
  assert.equal((out.match(/class="hs-row /g) || []).length, 2);
});

test('second real run renders up and down marks', () => {
  const store = S.mergeRun(make(), [
    { title: 'Alpha engine', score: 0 }, { title: 'Beta toolkit', score: 100 }
  ], { runId: 'r2', at: '2026-10-31T23:02:00Z' });
  const out = render(store);
  assert.match(out, /hs-mv-up" title="Up 1 since last run">▲1/);
  assert.match(out, /hs-mv-down" title="Down 1 since last run">▼1/);
  assert.equal(S.view(store, { status: 'ranked' }).items[0].title, 'Beta toolkit');
});

test('topOpen splits rows and preserves ordering', () => {
  const out = render(make(), { topOpen: 1 });
  assert.match(out, /<summary>Show 1 more<\/summary><ol class="hs-list" start="2">/);
  assert.ok(out.indexOf('Alpha engine') < out.indexOf('Show 1 more'));
  assert.ok(out.indexOf('Beta toolkit') > out.indexOf('Show 1 more'));
});

test('zero topOpen puts all rows in collapsed list', () => {
  const out = render(make(), { topOpen: 0 });
  assert.match(out, /<summary>Show 2 more<\/summary><ol class="hs-list" start="1">/);
});

test('escapes item content, attributes, and caller supplied labels', () => {
  const out = render(make([{ title: '<img src=x onerror=alert(1)>', score: 5, reason: `a&"'`, evidence: { text: '<script>', source: '"source"' } }]),
    { query: '<img', actions: () => [{ status: 'done" x="1', label: '<Done>' }] });
  assert.doesNotMatch(out, /<img src=x/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /a&amp;&quot;&#39;/);
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /done&quot; x=&quot;1/);
  assert.match(out, /&lt;Done&gt;/);
});

test('default actions and confirmation are present', () => {
  const out = render(make());
  assert.match(out, /data-status="approved">Approve/);
  assert.match(out, /data-status="done">Done/);
  assert.match(out, /data-status="trashed" data-confirm="1">Trash/);
});

test('custom actions replace defaults', () => {
  const out = render(make(), { actions: () => [{ status: 'done', label: 'Apply', confirm: true }] });
  assert.match(out, /data-status="done" data-confirm="1">Apply/);
  assert.doesNotMatch(out, />Approve<\/button>/);
});

test('custom status labels appear in filters and unranked status chips', () => {
  let store = make();
  const id = Object.values(store.items)[0].id;
  store = S.setStatus(store, id, 'done', { at });
  const out = render(store, { status: 'done', labels: { done: 'Applied', trashed: 'Dismissed' } });
  assert.match(out, /data-status="done" class="on" aria-pressed="true">Applied 1/);
  assert.match(out, /data-status="trashed" aria-pressed="false">Dismissed 0/);
  assert.match(out, /class="hs-st hs-st-done">Applied/);
  assert.match(out, /data-status="open">Reopen/);
  assert.doesNotMatch(out, /class="hs-rank"/);
});

test('empty view displays empty message and no runs', () => {
  const out = render(S.emptyStore('learned'), { emptyText: 'Nothing <found>' });
  assert.match(out, /class="hs-empty">Nothing &lt;found&gt;/);
  assert.match(out, /No runs yet/);
  assert.doesNotMatch(out, /class="hs-list"/);
});

test('run time is local 12-hour time and includes run counts', () => {
  const out = render(make());
  const local = new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  assert.ok(out.includes('Last run ' + local + ' · 2 new · 0 merged'));
  assert.match(local, /[AP]M/);
  assert.doesNotMatch(out, /Last run 23:/);
});

test('rendering is deterministic and does not mutate the view', () => {
  const view = S.view(make(), { status: 'ranked' }), before = structuredClone(view);
  assert.equal(H.html(view, { query: 'hello', now: 123 }), H.html(view, { query: 'hello', now: 123 }));
  assert.deepEqual(view, before);
});

test('summary evidence and custom detail appear in panel', () => {
  const out = render(make(), { detail: () => '<strong>Caller HTML</strong>' });
  assert.match(out, /<p>Summary<\/p>/);
  assert.match(out, /<ul class="hs-ev"><li>Evidence <span>Log · /);
  assert.match(out, /<strong>Caller HTML<\/strong>/);
});

test('movement covers unchanged, returned and unranked items', () => {
  assert.deepEqual(H.movement({ rank: null }), { cls: '', text: '', title: '' });
  assert.deepEqual(H.movement({ rank: 1, movement: 'same' }), { cls: 'hs-mv-same', text: '–', title: 'Same spot as last run' });
  assert.deepEqual(H.movement({ rank: 1, movement: 'returned' }), { cls: 'hs-mv-back', text: '↺', title: 'Back in the standings' });
});

function fakeRoot() {
  const listeners = {}, input = { value: 'needle' }, selected = { dataset: { status: 'ranked' } };
  return {
    dataset: {}, listeners, input, selected,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    contains() { return true; },
    querySelector(selector) { return selector === '.hs-q' ? input : selected; },
    emit(type, target, key) { for (const fn of listeners[type]) fn({ target, key, preventDefault() {} }); }
  };
}
function fakeButton(kind, dataset = {}) {
  const classes = new Set();
  return {
    dataset, textContent: 'Trash', disabled: false,
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    matches: selector => selector === kind
  };
}

test('wire replaces handlers without stacking and delegates filters', () => {
  const root = fakeRoot(), calls = [];
  H.wire(root, { onFilter: () => calls.push('old') });
  H.wire(root, { onFilter: value => calls.push(value) });
  const button = fakeButton('.hs-filter button', { status: 'done' });
  button.closest = () => button;
  root.emit('click', button);
  assert.equal(root.listeners.click.length, 1);
  assert.deepEqual(calls, [{ query: 'needle', status: 'done' }]);
});

test('confirming an action arms it, then disables it until the promise settles', async () => {
  const root = fakeRoot(), calls = [];
  let finish;
  H.wire(root, { onAction: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } });
  const button = fakeButton('.hs-act', { id: 'item', status: 'trashed', confirm: '1' });
  button.closest = () => button;
  root.emit('click', button);
  assert.equal(button.textContent, 'Sure?');
  assert.equal(calls.length, 0);
  root.emit('click', button);
  assert.equal(button.textContent, 'Trash');
  assert.deepEqual(calls[0], ['item', 'trashed', button]);
  assert.equal(button.disabled, true);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, false);
});

test('search input debounces and reads current filter', async () => {
  const root = fakeRoot(), calls = [];
  H.wire(root, { onFilter: value => calls.push(value) });
  root.input.matches = selector => selector === '.hs-q';
  root.emit('input', root.input);
  root.input.value = 'updated';
  root.selected.dataset.status = 'done';
  root.emit('input', root.input);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(calls, [{ query: 'updated', status: 'done' }]);
});

test('keyboard Enter and Details toggle the same panel', () => {
  const root = fakeRoot(), panel = { hidden: true };
  const button = fakeButton('.hs-more');
  button.setAttribute = (name, value) => { button[name] = value; };
  const row = { matches: selector => selector === '.hs-row', querySelector: selector => selector === '.hs-detail' ? panel : button };
  button.closest = selector => selector === '.hs-row' ? row : button;
  H.wire(root, {});
  root.emit('keydown', row, 'Enter');
  assert.equal(panel.hidden, false);
  assert.equal(button['aria-expanded'], 'true');
  root.emit('click', button);
  assert.equal(panel.hidden, true);
  assert.equal(button['aria-expanded'], 'false');
});
