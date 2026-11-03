'use strict';
/* Folders outside HQ that some features use, from os-config.json "places" (a path may start with ~ or be relative
   to the HQ folder; "orcaWorktree" may also sit at the top level, as it did before):
   companions    the companion tools folder: bin/ (cass, qmd), knowledge/ (shared notes, lessons, failure registry),
                 logs/heartbeats, data/ingest, start.cmd
   workbench     where agent work is handed off: handoffs/specs and handoffs/reports
   orcaWorktree  the Orca worktree that orca commands run in
   Missing ones are folders next to HQ. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT = path.resolve(__dirname, '..');
const DEFAULTS = { companions: '../companions', workbench: '../workbench', orcaWorktree: '../workbench' };

function places(kit = KIT) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(kit, 'os-config.json'), 'utf8')); } catch { /* defaults */ }
  const set = { ...(cfg.orcaWorktree ? { orcaWorktree: cfg.orcaWorktree } : {}), ...(cfg.places || {}) };
  const at = p => path.resolve(kit, String(p).replace(/^~(?=[\\/]|$)/, os.homedir()));
  return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, at(set[key] || DEFAULTS[key])]));
}

module.exports = { places, ...places() };
