'use strict';
/* LOCAL ADD-ONS: addons/<name>/ folders that stay on this computer (the public tree ships none).
   addon.json says what an add-on brings:
     "pages":       { "scripts": [...], "styles": [...] }   page files assets/hq-addons.js loads (they call hqPages.register)
     "dock":        [{ "page", "title", "icon" }]          toolbar buttons for those pages
     "appIcons":    { "<app id>": ["<icon>", "<tint>"] }   Micro Apps tile icons
     "rankedViews": [{ "endpoint", "hideText" }]           extra views for tools/ranked-dupes.mjs
     "brain":       { "scripts", "styles", "tabs": [{ "view", "title" }] }   Second Brain board tabs: the shell (copy.js)
                    adds the tabs after Applications; views/addon-boards.js loads the files, which call UsageBoard.addView
     "usage":       ["<file>.mjs"]                         refresh/usage.mjs extras: each default export gets the usage
                    figures ({ kit, out, now, windows, cutoff }) and returns fields to add to data/arms-usage.json
   An optional server.cjs exports (ctx) => ({ handle(req, res, { p2, u, post }) }); handle returns true once it
   has answered. HQ_ADDONS_DIR points tests at another folder; HQ_DEMO=1 or HQ_NO_ADDONS=1 loads none. */
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PAGE_FILE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:js|css)$/;
const NODE_FILE = /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:mjs|cjs)$/;

const dirOf = (kit, env = process.env) => env.HQ_ADDONS_DIR ? path.resolve(env.HQ_ADDONS_DIR) : path.join(kit, 'addons');
const off = (env = process.env) => env.HQ_DEMO === '1' || env.HQ_NO_ADDONS === '1';

function tidy(raw) {
  const m = raw && typeof raw === 'object' ? raw : {};
  const text = (v, max) => String(v == null ? '' : v).slice(0, max);
  const files = list => (Array.isArray(list) ? list : []).filter(f => typeof f === 'string' && PAGE_FILE.test(f));
  const pages = m.pages && typeof m.pages === 'object' ? m.pages : {};
  const dock = (Array.isArray(m.dock) ? m.dock : []).filter(d => d && /^[a-z0-9-]{1,40}$/.test(d.page))
    .map(d => ({ page: d.page, title: text(d.title || d.page, 60), icon: text(d.icon || 'gen', 30) }));
  const appIcons = {};
  for (const [id, v] of Object.entries(m.appIcons && typeof m.appIcons === 'object' ? m.appIcons : {}))
    if (/^[a-z0-9-]{1,60}$/.test(id) && Array.isArray(v) && typeof v[0] === 'string') appIcons[id] = [text(v[0], 30), text(v[1], 4)];
  const rankedViews = (Array.isArray(m.rankedViews) ? m.rankedViews : [])
    .filter(v => v && typeof v.endpoint === 'string' && v.endpoint.startsWith('/api/'))
    .map(v => ({ endpoint: v.endpoint, hideText: v.hideText === true }));
  const brain = m.brain && typeof m.brain === 'object' ? m.brain : {};
  const tabs = (Array.isArray(brain.tabs) ? brain.tabs : []).filter(t => t && /^[a-z][a-z0-9-]{0,30}$/.test(t.view))
    .map(t => ({ view: t.view, title: text(t.title || t.view, 40) }));
  const usage = (Array.isArray(m.usage) ? m.usage : []).filter(f => typeof f === 'string' && NODE_FILE.test(f));
  return { pages: { scripts: files(pages.scripts), styles: files(pages.styles) }, dock, appIcons, rankedViews,
    brain: { scripts: files(brain.scripts), styles: files(brain.styles), tabs }, usage };
}

/* Every add-on folder with a readable addon.json, by name. Reads files only; runs no add-on code. */
function manifests(kit, env = process.env) {
  if (off(env)) return [];
  const dir = dirOf(kit, env);
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && NAME.test(d.name)).map(d => d.name).sort(); }
  catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const root = path.join(dir, name);
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(root, 'addon.json'), 'utf8').replace(/^﻿/, '')); }
    catch (e) { if (e.code !== 'ENOENT') console.warn(`[addons] ${name}: addon.json is not valid JSON (${e.message})`); continue; }
    out.push({ name, root, ...tidy(raw) });
  }
  return out;
}

/* manifests() plus each server.cjs, started with the server's helpers. One that fails to start keeps its pages. */
function mount(kit, ctx, env = process.env) {
  return manifests(kit, env).map(addon => {
    const file = path.join(addon.root, 'server.cjs');
    let handle = null;
    if (fs.existsSync(file)) {
      try {
        const made = require(file)({ ...ctx, root: addon.root, name: addon.name });
        if (made && typeof made.handle === 'function') handle = made.handle;
      } catch (e) { console.warn(`[addons] ${addon.name}: server.cjs did not start (${String(e.message || e).slice(0, 200)})`); }
    }
    return { ...addon, handle };
  });
}

/* What the page needs (/api/addons): file URLs, dock buttons, app icons and Second Brain tabs, never folder paths. */
function pageList(list) {
  const urls = (a, files) => files.map(f => `addons/${a.name}/${f}`);
  return list.map(a => ({ name: a.name, scripts: urls(a, a.pages.scripts), styles: urls(a, a.pages.styles), dock: a.dock,
    appIcons: a.appIcons, brain: { scripts: urls(a, a.brain.scripts), styles: urls(a, a.brain.styles), tabs: a.brain.tabs } }));
}

/* /addons/<name>/<file> -> the file, only when that add-on's addon.json lists it under "pages" or "brain". */
function pageFile(list, p2) {
  let rel; try { rel = decodeURIComponent(p2).replace(/^\/addons\//, ''); } catch (_) { return null; }
  const cut = rel.indexOf('/'), addon = cut > 0 && list.find(a => a.name === rel.slice(0, cut));
  const file = cut > 0 ? rel.slice(cut + 1) : '';
  if (!addon || ![...addon.pages.scripts, ...addon.pages.styles, ...addon.brain.scripts, ...addon.brain.styles].includes(file)) return null;
  return path.join(addon.root, ...file.split('/'));
}

/* The "usage" modules refresh/usage.mjs runs, as file paths. Same rules as manifests(): none in demo mode. */
function usageFiles(kit, env = process.env) {
  return manifests(kit, env).flatMap(a => a.usage.map(f => path.join(a.root, ...f.split('/'))));
}

module.exports = { manifests, mount, pageList, pageFile, usageFiles, dirOf };
