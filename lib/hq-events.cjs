'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(KIT, 'os-runs', 'events.jsonl');
const DEFAULT_DEDUPE_MS = 30 * 60 * 1000;
const ROTATE_BYTES = 5 * 1024 * 1024;
const SEVERITIES = new Set(['info', 'warn', 'error']);

const eventFile = file => path.resolve(file || process.env.HQ_EVENTS_FILE || DEFAULT_FILE);
const parseTime = value => {
  if (value === undefined || value === null || value === '') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

function filesFor(file) {
  const current = eventFile(file), dir = path.dirname(current);
  const stem = path.basename(current, path.extname(current));
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return fs.existsSync(current) ? [current] : []; }
  return names.filter(name => name === path.basename(current) || (name.startsWith(stem + '-') && name.endsWith('.jsonl')))
    .map(name => path.join(dir, name)).filter(name => {
      try { return fs.statSync(name).isFile(); } catch (_) { return false; }
    });
}

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch (_) { return []; }
}

function hasRecentKey(file, key, cutoff) {
  if (!key) return false;
  for (const name of filesFor(file)) {
    const lines = readLines(name);
    for (let i = lines.length - 1; i >= 0; i--) {
      let event; try { event = JSON.parse(lines[i]); } catch (_) { continue; }
      const time = parseTime(event.ts);
      if (event.key === key && time !== null && time >= cutoff) return true;
    }
  }
  return false;
}

function rotatedName(file, now = new Date()) {
  const dir = path.dirname(file), ext = path.extname(file) || '.jsonl';
  const stem = path.basename(file, ext), day = now.toISOString().slice(0, 10).replace(/-/g, '');
  let candidate = path.join(dir, `${stem}-${day}${ext}`), n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${stem}-${day}-${n++}${ext}`);
  return candidate;
}

function rotateIfNeeded(file) {
  let size = 0; try { size = fs.statSync(file).size; } catch (_) { return null; }
  if (size <= ROTATE_BYTES) return null;
  const rotated = rotatedName(file);
  fs.renameSync(file, rotated);
  return rotated;
}

function removeKeys(file, keys) {
  const wanted = new Set((keys || []).map(String));
  if (!wanted.size) return 0;
  let removed = 0;
  for (const name of filesFor(file)) {
    const kept = [];
    for (const line of readLines(name)) {
      let event; try { event = JSON.parse(line); } catch (_) { kept.push(line); continue; }
      if (wanted.has(String(event.key))) removed += 1;
      else kept.push(line);
    }
    if (removed) {
      const tmp = name + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      fs.renameSync(tmp, name);
    }
  }
  return removed;
}

function append(input = {}, options = {}) {
  const file = eventFile(options.file), now = new Date();
  const dedupeWindowMs = Number(options.dedupeWindowMs ?? input.dedupeWindowMs ?? DEFAULT_DEDUPE_MS);
  const key = input.key === undefined || input.key === null ? null : String(input.key);
  if (key && Number.isFinite(dedupeWindowMs) && dedupeWindowMs > 0 && hasRecentKey(file, key, now.getTime() - dedupeWindowMs)) {
    return { deduped: true };
  }
  const replaced = removeKeys(file, options.supersedesKeys);
  const event = {
    ts: now.toISOString(), id: crypto.randomUUID(), type: String(input.type || ''), source: String(input.source || 'hq'),
    severity: SEVERITIES.has(input.severity) ? input.severity : 'info', key, summary: String(input.summary || ''),
    ref: input.ref === undefined || input.ref === null ? null : String(input.ref),
    data: input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {}
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
  const rotated = rotateIfNeeded(file);
  return { deduped: false, event, rotated, replaced };
}

function list(options = {}) {
  const file = eventFile(options.file), since = parseTime(options.since);
  const limit = Math.max(1, Math.min(1000, Number(options.limit) || 50));
  const events = [];
  for (const name of filesFor(file)) for (const line of readLines(name)) {
    let event; try { event = JSON.parse(line); } catch (_) { continue; }
    const time = parseTime(event.ts);
    if (time === null || (since !== null && time < since)) continue;
    if (options.type && event.type !== options.type) continue;
    if (options.severity && event.severity !== options.severity) continue;
    events.push(event);
  }
  return events.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, limit);
}

module.exports = { append, list, removeKeys, DEFAULT_FILE, DEFAULT_DEDUPE_MS, ROTATE_BYTES };
