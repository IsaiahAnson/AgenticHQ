/* Automations: the hidden agentic jobs (Windows Task Scheduler jobs, Claude hooks and the
   desktop routines that audit agents) for the Second Brain's Automations ring.
   config/automations.json says which jobs belong and what each one writes; schedules and
   results are read live. Read-only: never starts, stops or edits a job. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const KIT = path.resolve(__dirname, '..', '..');
const CFG_FILE = path.join(KIT, 'config', 'automations.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
const abs = p => /^[a-z]:/i.test(p) ? p : path.join(KIT, p);

// Task Scheduler result codes that are not failures
const OK_RESULTS = { 0: 'ok', 267009: 'running', 267011: 'not run yet', 267010: 'disabled', 267008: 'ready' };

function windowsTasks(cfg) {
  const names = [...(cfg.prefixes || []).map(p => p + '*'), ...(cfg.extra || [])].map(n => `'${n.replace(/'/g, "''")}'`).join(',');
  if (!names) return [];   // no names would list every task on the PC
  const ps = `$ErrorActionPreference='SilentlyContinue'; @(Get-ScheduledTask -TaskName ${names} | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; [pscustomobject]@{ name=$_.TaskName; state=[string]$_.State; next=if($i.NextRunTime){$i.NextRunTime.ToString('o')}else{$null}; last=if($i.LastRunTime -and $i.LastRunTime.Year -gt 2000){$i.LastRunTime.ToString('o')}else{$null}; result=$i.LastTaskResult; missed=$i.NumberOfMissedRuns; action=(($_.Actions | ForEach-Object { ($_.Execute + ' ' + $_.Arguments).Trim() }) -join ' ; '); trig=(($_.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task','' -replace 'Trigger','' }) -join ', ') } }) | ConvertTo-Json -Compress`;
  let list = [];
  try { list = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20000, windowsHide: true }) || '[]'); } catch { return []; }
  if (!Array.isArray(list)) list = [list];
  return list.map(t => {
    const job = (cfg.jobs || {})[t.name] || {};
    const script = (String(t.action).match(/tools[\\/][\w.-]+\.(mjs|ps1|cjs|js)(\s+[\w-]+)?/) || [String(t.action).split(' ; ')[0]])[0];
    const status = t.state === 'Disabled' ? 'disabled' : OK_RESULTS[t.result] || `failed (0x${(t.result >>> 0).toString(16)})`;
    return { id: 'auto:win:' + slug(t.name), name: t.name.replace(/^Agentic HQ /, ''), kind: 'windows-task', desc: job.desc || '', learns: !!job.learns,
      schedule: t.trig || 'On demand', lastRun: t.last, nextRun: t.next, lastResult: status,
      warn: status.startsWith('failed') || (t.missed > 0 && status !== 'disabled'), missed: t.missed || 0, script, writes: job.writes || [] };
  });
}

function hooks(cfg) {
  const settings = readJson(path.join(os.homedir(), '.claude', 'settings.json'), {});
  const seen = new Map();
  for (const [event, groups] of Object.entries(settings.hooks || {})) for (const g of groups || []) for (const h of g.hooks || []) {
    const cmd = String(h.command || h.url || '');
    const key = (cfg.match || []).find(m => cmd.includes(m));
    if (!key) continue;
    const id = key === 'rubric-agentic-os-v2' ? (cmd.match(/tools\/([\w-]+)\.mjs/) || [, 'hq-hook'])[1] : key;
    const job = (cfg.jobs || {})[id] || {};
    const e = seen.get(id) || { id: 'auto:hook:' + slug(id), name: id, kind: 'hook', desc: job.desc || '', learns: !!job.learns, events: [], lastRun: null, nextRun: null,
      lastResult: 'on', warn: false, script: cmd.replace(/\s+/g, ' ').slice(0, 140), writes: job.writes || [] };
    e.events.push(g.matcher && g.matcher !== '*' ? `${event} (${g.matcher})` : event);
    seen.set(id, e);
  }
  return [...seen.values()].map(e => ({ ...e, schedule: [...new Set(e.events)].join(', ') }));
}

function coverage(item, roots) {
  if (item.audits) return 'watchdog';
  const w = (item.writes || []).map(p => norm(abs(p)));
  if (!w.length) return 'nothing to watch';
  const r = roots.map(p => norm(abs(p)));
  const hit = w.filter(p => r.some(x => p.startsWith(x) || x.startsWith(p)));
  return !item.learns ? (hit.length ? 'covered' : 'not needed') : hit.length === w.length ? 'covered' : hit.length ? 'partly covered' : 'not covered';
}

/** All automations, plus a lookup for desktop routines that belong on the ring. */
function readAutomations() {
  const cfg = readJson(CFG_FILE, {});
  const roots = cfg.watchedRoots || [];
  const items = [...windowsTasks(cfg.windowsTasks || {}), ...hooks(cfg.hooks || {})];
  for (const it of items) it.watchdog = coverage(it, roots);
  const desktop = Object.fromEntries(Object.entries(cfg.desktopRoutines || {}).map(([id, j]) => [id, { ...j, watchdog: coverage(j, roots) }]));
  return { items, desktop };
}

module.exports = { readAutomations, CFG_FILE };
