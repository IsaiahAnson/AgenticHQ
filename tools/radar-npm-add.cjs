#!/usr/bin/env node
/* AI Radar Implement: the only way the build agent may add npm packages.
   Usage (from inside a radar worktree): node <HQ>/tools/radar-npm-add.cjs <name>@<x.y.z> [<name>@<x.y.z> ...]
   Accepts exact registry versions only (no ranges, tags, URLs, git or file specs, no flags), refuses to run outside
   a radar worktree, and runs `npm install --ignore-scripts --save-exact` itself with an argument array (no shell).
   It lives in the main checkout, which the agent's file tools cannot reach, so the agent can't loosen it. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SPEC_RE = /^(@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}@\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,40})?$/;

function checkSpecs(args) {
  if (!args.length) return 'give one or more exact specs, e.g. left-pad@1.3.0';
  for (const a of args) if (!SPEC_RE.test(a)) return `refused "${String(a).slice(0, 120)}": only name@x.y.z (exact version, no flags, tags, ranges, URLs or paths)`;
  return null;
}
function inRadarWorktree(cwd, kit) {
  const root = path.resolve(kit, '..', 'radar-worktrees') + path.sep;
  return path.resolve(cwd).toLowerCase().startsWith(root.toLowerCase()) && fs.existsSync(path.join(cwd, 'package.json'));
}

if (require.main === module) {
  const args = process.argv.slice(2), kit = path.resolve(__dirname, '..');
  const bad = checkSpecs(args);
  if (bad) { console.error(bad); process.exit(2); }
  if (!inRadarWorktree(process.cwd(), kit)) { console.error('run this from a radar worktree that has a package.json'); process.exit(2); }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) { console.error('npm was not found next to node'); process.exit(2); }
  const r = spawnSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--save-exact', '--no-fund', '--no-audit', ...args], { stdio: 'inherit', windowsHide: true });
  process.exit(r.status == null ? 1 : r.status);
}
module.exports = { checkSpecs, inRadarWorktree, SPEC_RE };
