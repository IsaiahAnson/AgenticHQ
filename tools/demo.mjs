#!/usr/bin/env node
/* npm run demo: Agentic HQ with mock data (demo mode, lib/demo.cjs), in a sandbox copy, so nothing on this
   computer is read or changed. It copies the kit to a temp folder (leaving out .git, node_modules, data, runs,
   ring pages, snapshots, add-ons, tests, generated map files and sign-in files), lays demo/overlay/ over the copy,
   builds the demo workspace (demo/workspace-gen.mjs), its Second Brain map and a month of mock usage
   (demo/usage-gen.mjs, then refresh/usage.mjs), then starts server.js there with HQ_DEMO=1 and an empty sandbox home.
   Options: --port=<n> (default 50170; the map engine takes the next port), --dir=<sandbox folder>. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolve: resolveTokens } = require('../lib/demo.cjs');
const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');
const port = Number(arg('port')) || 50170;
const dir = path.resolve(arg('dir') || path.join(os.tmpdir(), 'agentic-hq-demo'));
const MARK = '.agentic-hq-demo';

const SKIP_TOP = new Set(['.git', 'node_modules', 'data', 'os-runs', 'artifacts', 'snapshots', 'voice', 'addons', 'test', 'tests', 'sn-upload', '.design-shots', '.playwright-cli']);
const GENERATED = new Set(['brain/snapshot.js', 'brain/snapshot-expansions.js', 'brain/_icons.js', 'brain/map-layouts.js', 'assets/home-orb-mini.js']);
const PRIVATE = /^(?:\.env.*|\.google-.*\.json|.*\.pem|secrets\.local\.json|credentials\.json|token\.json|.*\.bak.*)$/i;
function keep(src) {
  const rel = path.relative(KIT, src).split(path.sep).join('/');
  if (!rel) return true;
  return !SKIP_TOP.has(rel.split('/')[0]) && !GENERATED.has(rel) && !PRIVATE.test(path.basename(rel));
}

/* a fresh sandbox; an existing folder is removed only when an earlier demo made it */
if (fs.existsSync(dir)) {
  if (!fs.existsSync(path.join(dir, MARK)) && fs.readdirSync(dir).length) { console.error(`${dir} is not an earlier demo sandbox; pick another --dir.`); process.exit(1); }
  fs.rmSync(dir, { recursive: true, force: true });
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, MARK), 'Made by tools/demo.mjs; the next demo run replaces this folder.\n');
fs.cpSync(KIT, dir, { recursive: true, filter: keep });
fs.cpSync(path.join(KIT, 'demo', 'overlay'), dir, { recursive: true, force: true });

/* ring page sidecars may hold time tokens ("created": "@iso:-2d@08:15"), so the ring always looks recent;
   the ring sorts by file time, so each page and sidecar gets its "created" time (a copy is stamped "now") */
const ring = path.join(dir, 'artifacts');
for (const f of fs.existsSync(ring) ? fs.readdirSync(ring).filter(f => f.endsWith('.json')) : []) {
  const file = path.join(ring, f), card = resolveTokens(JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.writeFileSync(file, JSON.stringify(card, null, 2) + '\n');
  const at = new Date(card.created);
  if (!isNaN(at)) for (const page of [file, file.replace(/\.json$/, '.html')]) if (fs.existsSync(page)) fs.utimesSync(page, at, at);
}

const home = path.join(dir, '.demo-home');
for (const sub of ['AppData/Roaming', 'AppData/Local', '.claude']) fs.mkdirSync(path.join(home, sub), { recursive: true });
/* three sample Claude hooks for the Automations ring (config/automations.json "hooks"); the demo never runs them */
const hook = command => [{ hooks: [{ type: 'command', command }] }];
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
  SessionStart: hook('node hooks/skill-gotcha-check.mjs'), Stop: hook('node hooks/lesson-capture.mjs'), PostToolUse: hook('node hooks/ring-publish.mjs')
} }, null, 2) + '\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^HQ_|^MONEY_|^RUBRIC_|KEY|TOKEN|SECRET|PASSWORD/i.test(k)));
Object.assign(env, { HQ_DEMO: '1', PORT: String(port), BRAIN_PORT: String(port + 1), HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });

const step = (label, file, ...args) => {
  if (!fs.existsSync(path.join(dir, file))) return;
  const r = spawnSync(process.execPath, ['--no-warnings', file, ...args], { cwd: dir, env, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  if (r.status !== 0) { console.error(`  ${label} failed (exit ${r.status}).`); process.exit(1); }
  console.log(`  ${label}: done`);
};
console.log(`Agentic HQ demo sandbox: ${dir}`);
step('demo workspace', 'demo/workspace-gen.mjs', path.join(dir, 'demo', 'workspace'));
step('Second Brain map', 'refresh/brain.mjs');
step('demo usage log', 'demo/usage-gen.mjs', dir);
step('usage figures', 'refresh/usage.mjs');

const server = spawn(process.execPath, ['server.js'], { cwd: dir, env, stdio: 'inherit', windowsHide: true });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.kill());
server.on('exit', code => process.exit(code ?? 0));
