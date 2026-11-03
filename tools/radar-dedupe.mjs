#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, acquireLock, releaseLock, foldRadarDuplicates } from './ai-radar.mjs';

const require = createRequire(import.meta.url);
const standings = require('../lib/standings.cjs');
let dir = path.join(ROOT, 'data', 'radar'), write = false, json = false;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' && args[i + 1] && !args[i + 1].startsWith('--')) dir = path.resolve(args[++i]);
    else if (args[i] === '--write') write = true;
    else if (args[i] === '--json') json = true;
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  let lock;
  if (write) {
    lock = acquireLock(dir, { runId: 'radar-dedupe' });
    if (!lock.ok) throw new Error(`Radar is locked by pid ${lock.holder.pid}`);
  }
  try {
    const file = path.join(dir, 'standings.json');
    const before = standings.load(file, 'radar');
    let decisions;
    try { decisions = JSON.parse(fs.readFileSync(path.join(dir, 'decisions.json'), 'utf8')); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    const after = foldRadarDuplicates(before, { decisions, at: new Date().toISOString() });
    const counts = store => standings.view(store).counts;
    const folds = Object.values(after.items).map(item => ({
      id: item.id, title: item.title,
      folded: Object.values(before.items).filter(old => old.id !== item.id && standings.resolveId(after, old.id) === item.id)
        .map(old => ({ id: old.id, title: old.title }))
    })).filter(group => group.folded.length);
    if (write) standings.save(file, after);
    const output = { before: counts(before), after: counts(after), folds, written: write };
    if (json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`Before: ${JSON.stringify(output.before)}\nAfter: ${JSON.stringify(output.after)}`);
      for (const fold of folds) console.log(`${fold.id} ${fold.title} <- ${fold.folded.map(item => `${item.id} ${item.title}`).join('; ')}`);
    }
  } finally {
    if (lock && !releaseLock(dir, lock.status)) throw new Error('Radar lock ownership changed before release');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
