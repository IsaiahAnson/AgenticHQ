'use strict';
// Accepted sentinel checks: a failing check you have seen and chosen to live with stops warning,
// until its value gets more than WORSE_PCT worse than when you accepted it.
// State: data/sentinel-accepted.json  { "<checkId>": { acceptedAt, value, worse: 'higher'|'lower', note } }
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'sentinel-accepted.json');
const WORSE_PCT = 10;

const load = (file = FILE) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
const save = (all, file = FILE) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all, null, 1)); };

// How far past the accepted value counts as "worse": higher-is-worse checks fail above value * 1.1, lower-is-worse below value * 0.9.
function worsened(entry, value) {
  if (!Number.isFinite(value) || !Number.isFinite(entry.value)) return false;
  const step = Math.abs(entry.value) * WORSE_PCT / 100;
  return entry.worse === 'lower' ? value < entry.value - step : value > entry.value + step;
}

// results: [{ id, ok, summary, data: { value, worse } }] -> same list, with accepted failures turned ok and marked accepted.
function apply(results, all = load()) {
  return results.map(r => {
    const entry = all[r.id];
    if (r.ok || !entry) return r;
    if (worsened(entry, r.data?.value)) return { ...r, summary: `${r.summary} (was accepted at ${entry.value})` };
    return { ...r, ok: true, accepted: true, summary: `${r.summary} [accepted]` };
  });
}

// last: the check's latest result from os-runs/sentinel-state.json ({ ok, data: { value, worse } }).
function accept(id, last, note = '', file = FILE) {
  if (!last) throw new Error(`unknown check: ${id}`);
  const value = last.data?.value, worse = last.data?.worse;
  if (!Number.isFinite(value) || !['higher', 'lower'].includes(worse)) throw new Error(`check ${id} has no measured value to accept`);
  const all = load(file);
  all[id] = { acceptedAt: new Date().toISOString(), value, worse, note: String(note).slice(0, 200) };
  save(all, file);
  return all[id];
}

function unaccept(id, file = FILE) {
  const all = load(file);
  if (!all[id]) throw new Error(`check ${id} is not accepted`);
  delete all[id];
  save(all, file);
  return true;
}

module.exports = { FILE, WORSE_PCT, load, apply, accept, unaccept, worsened };
