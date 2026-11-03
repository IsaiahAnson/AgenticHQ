// Opens Agentic HQ (http://localhost:50000) in its own Edge app window once HQ answers.
// Run at sign-in by the "Agentic HQ Window" task: wscript.exe tools\run-hidden.vbs tools\open-hq-window.mjs
// Waits up to 3 minutes for /api/health, then launches Edge with --app (no toolbar or tabs; normal keyboard,
// mouse and accessibility, unlike a Lively wallpaper). Pass --dry-run to only report what it would do.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HQ = 'http://localhost:50000';
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const DRY = process.argv.includes('--dry-run');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  try { up = (await fetch(`${HQ}/api/health`, { signal: AbortSignal.timeout(3000) })).ok; } catch { }
  if (!up) await sleep(2000);
}
if (!up) { console.error('Agentic HQ did not answer within 3 minutes; no window opened'); process.exit(1); }
if (!EDGE) { console.error('Microsoft Edge not found'); process.exit(1); }
// Its own Edge profile folder: handing --app to an already-open Edge session sometimes opens nothing (2026-10-29).
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'AgenticHQ', 'edge-app');
fs.mkdirSync(DATA_DIR, { recursive: true });
const args = [`--user-data-dir=${DATA_DIR}`, `--app=${HQ}/`, '--start-maximized', '--no-first-run', '--no-default-browser-check'];
if (DRY) { console.log('would run:', EDGE, args.join(' ')); process.exit(0); }
spawn(EDGE, args, { detached: true, stdio: 'ignore' }).unref();
console.log('opened Agentic HQ window');
