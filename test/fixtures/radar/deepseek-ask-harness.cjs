'use strict';
// Runs the DeepSeek helper script (config/radar.json deepseek.script) the way runDeepseek does (powershell -File, hidden, piped) against a fake orca:
// node.exe linked as orca.exe with fake-orca.cjs preloaded, printing UTF-8 JSON as orca does. No PATH entry that holds
// the real orca is kept, so these tests never drive DeepSeek. Used by test/deepseek-utf8.test.cjs and
// test/deepseek-nudge.test.cjs; `env` sets the FAKE_ORCA_* knobs described in fake-orca.cjs.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'radar.json'), 'utf8')).deepseek.script;
const skip = process.platform !== 'win32' || !fs.existsSync(SCRIPT) ? 'needs Windows PowerShell and the deepseek-ask.ps1 that config/radar.json deepseek.script names' : false;

function runAsk(t, { prompt, env: knobs = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-deepseek-ask-'));
  // Under a busy full suite Windows can still hold orca.exe when the test ends (EPERM, which rmSync's own maxRetries
  // doesn't retry on Node 24): try for about 3 s, then leave the temp folder behind.
  t.after(async () => {
    for (let i = 0; i < 10; i++) {
      try { return fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { await new Promise(r => setTimeout(r, 300)); }
    }
  });
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  try { fs.linkSync(process.execPath, path.join(bin, 'orca.exe')); } catch (_) { fs.copyFileSync(process.execPath, path.join(bin, 'orca.exe')); }

  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  const exts = [...String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';'), '.PS1'].filter(Boolean);
  const hasOrca = p => exts.some(ext => fs.existsSync(path.join(p.replace(/"/g, ''), 'orca' + ext)));
  env[pathKey] = [bin, ...String(env[pathKey] || '').split(';').filter(p => p.trim() && !hasOrca(p))].join(';');
  env.NODE_OPTIONS = `--require "${path.join(__dirname, 'fake-orca.cjs').replace(/\\/g, '/')}"`;
  env.FAKE_ORCA_STATE = path.join(dir, 'orca-state.json');
  Object.assign(env, knobs);

  const pf = path.join(dir, 'ask.prompt.md'), of = path.join(dir, 'ask.reply.md');
  fs.writeFileSync(pf, prompt, 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-PromptFile', pf, '-OutFile', of,
    '-NewChat', '-TimeoutSec', '60', '-PollSec', '0'], { env, windowsHide: true, encoding: 'utf8', timeout: 150000 });
  const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return { r, md: read(of), state: JSON.parse(read(env.FAKE_ORCA_STATE) || '{}') };
}

module.exports = { SCRIPT, skip, runAsk };
