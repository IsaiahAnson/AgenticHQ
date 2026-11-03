#!/usr/bin/env node
/* Folds every copy of one lesson on What HQ Learned into one entry that lists each skill it applies to (same text, a
   near-identical rewording, or a pair named with --merge keep=drop, item or proposal ids). Each skill keeps its own
   status; a waiting same-skill copy is rejected as merged. Prints before/after counts; writes only with --write. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const standings = require('../lib/standings.cjs');
const gotchas = require('../lib/gotcha-proposals.cjs');
const { duplicateReport } = require('../lib/ranked-dupes.cjs');
const { withLock } = require('../lib/store-lock.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function counts(store) {
  const all = Object.values(store.items), top = standings.view(store, { status: 'ranked', limit: 100, opts: gotchas.LEARNED_OPTS }).items;
  const copies = duplicateReport(all), ranked = duplicateReport(top);
  return { items: all.length, statuses: standings.view(store, { opts: gotchas.LEARNED_OPTS }).counts, duplicateTexts: copies.duplicateTexts,
    extraCopies: copies.extraCopies, top100: { total: ranked.total, unique: ranked.unique } };
}

let dataDir = path.join(ROOT, 'data'), write = false, json = false;
const merges = [];
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1] && !args[i + 1].startsWith('--')) dataDir = path.resolve(args[++i]);
    else if (args[i] === '--merge' && /^[^=\s]+=[^=\s]+$/.test(args[i + 1] || '')) merges.push(args[++i].split('='));
    else if (args[i] === '--write') write = true;
    else if (args[i] === '--json') json = true;
    else throw new Error(`Unknown or incomplete argument: ${args[i]}\nUsage: node tools/learned-dedupe.mjs [--data-dir DIR] [--merge KEEP=DROP]... [--write] [--json]`);
  }
  const storeFile = path.join(dataDir, 'standings', 'learned.json'), proposalsFile = path.join(dataDir, 'gotcha-proposals.json');
  const dedupe = () => {
    const before = standings.load(storeFile, 'learned'), state = gotchas.readState(proposalsFile), at = new Date().toISOString();
    const out = gotchas.foldLearnedDuplicates(before, state, { at, merges });
    // A folded entry is open while any of its skills waits, done once one was applied, trashed when all were dismissed.
    // A --merge can fold an earlier fold's survivor away, so each fold reports the item it ended up in.
    const survivor = id => standings.resolveId(out.store, id);
    const after = gotchas.syncTargets(out.store, state, { at, only: new Set(out.folds.map(f => survivor(f.keep)).filter(Boolean)) });
    if (write && out.folds.length) {
      gotchas.atomicWrite(proposalsFile, JSON.stringify(state, null, 2) + '\n');
      standings.save(storeFile, after);
    }
    const folds = out.folds.map(f => { const item = after.items[survivor(f.keep)];
      return { keep: item.id, title: item.title, status: item.status, skills: f.skills, folded: f.drop.length }; });
    return { before: counts(before), after: counts(after), folds, rejected: out.rejected, written: write && out.folds.length > 0 };
  };
  const output = write ? withLock(storeFile, dedupe, { busyMessage: gotchas.LOCK_BUSY }) : dedupe();
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    for (const side of ['before', 'after']) {
      const c = output[side];
      console.log(`${side}: ${c.items} items ${JSON.stringify(c.statuses)}, ${c.duplicateTexts} texts with copies (${c.extraCopies} extra), top 100 holds ${c.top100.unique} unique of ${c.top100.total}`);
    }
    for (const f of output.folds) console.log(`${f.keep} [${f.status}] ${f.skills.join(', ')} <- ${f.folded} cop${f.folded === 1 ? 'y' : 'ies'}: ${f.title.slice(0, 90)}`);
    console.log(`${output.folds.length} folds, ${output.rejected.length} waiting copies rejected as merged${output.written ? ', written' : ' (dry run; --write saves)'}`);
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
