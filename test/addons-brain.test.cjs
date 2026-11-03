'use strict';
/* lib/addons.cjs "brain" and "usage": Second Brain board tabs and refresh/usage.mjs extras from a local add-on.
   Uses a throwaway add-on folder (HQ_ADDONS_DIR), never the real addons/. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { manifests, pageList, pageFile, usageFiles } = require('../lib/addons.cjs');

const KIT = path.resolve(__dirname, '..');

function fakeAddons(t, manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-addons-brain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'extra', 'brain'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extra', 'addon.json'), JSON.stringify(manifest));
  return { HQ_ADDONS_DIR: dir };
}

test('brain tabs, board files and usage modules come through tidied', t => {
  const env = fakeAddons(t, {
    brain: { scripts: ['brain/board.js', '../escape.js', 'brain/board.mjs'], styles: ['brain/board.css'],
      tabs: [{ view: 'extra', title: 'Extra' }, { view: 'Bad View', title: 'x' }, { view: 'notitle' }] },
    usage: ['brain/usage.mjs', 'brain/usage.js', '../usage.mjs']
  });
  const [addon] = manifests(KIT, env);
  assert.deepEqual(addon.brain, { scripts: ['brain/board.js'], styles: ['brain/board.css'],
    tabs: [{ view: 'extra', title: 'Extra' }, { view: 'notitle', title: 'notitle' }] });
  assert.deepEqual(addon.usage, ['brain/usage.mjs']);
  assert.deepEqual(usageFiles(KIT, env), [path.join(env.HQ_ADDONS_DIR, 'extra', 'brain', 'usage.mjs')]);

  const [page] = pageList(manifests(KIT, env));
  assert.deepEqual(page.brain, { scripts: ['addons/extra/brain/board.js'], styles: ['addons/extra/brain/board.css'],
    tabs: [{ view: 'extra', title: 'Extra' }, { view: 'notitle', title: 'notitle' }] });
});

test('only listed board files are served', t => {
  const env = fakeAddons(t, { brain: { scripts: ['brain/board.js'], styles: ['brain/board.css'] }, usage: ['brain/usage.mjs'] });
  const list = manifests(KIT, env);
  assert.equal(pageFile(list, '/addons/extra/brain/board.js'), path.join(env.HQ_ADDONS_DIR, 'extra', 'brain', 'board.js'));
  assert.equal(pageFile(list, '/addons/extra/brain/board.css'), path.join(env.HQ_ADDONS_DIR, 'extra', 'brain', 'board.css'));
  assert.equal(pageFile(list, '/addons/extra/brain/usage.mjs'), null);
  assert.equal(pageFile(list, '/addons/extra/addon.json'), null);
});

test('an add-on without brain or usage adds nothing, and demo mode runs no usage module', t => {
  const plain = fakeAddons(t, { pages: { scripts: ['a.js'] } });
  const [addon] = manifests(KIT, plain);
  assert.deepEqual(addon.brain, { scripts: [], styles: [], tabs: [] });
  assert.deepEqual(addon.usage, []);

  const env = fakeAddons(t, { usage: ['brain/usage.mjs'] });
  assert.equal(usageFiles(KIT, env).length, 1);
  assert.deepEqual(usageFiles(KIT, { ...env, HQ_DEMO: '1' }), []);
  assert.deepEqual(usageFiles(KIT, { ...env, HQ_NO_ADDONS: '1' }), []);
});
