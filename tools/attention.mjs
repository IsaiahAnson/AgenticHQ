#!/usr/bin/env node
// Attention budget CLI (lib/attention.cjs). No model calls.
//   node tools/attention.mjs digest [--dry-run]  - the 20:00 digest push + ring report (Windows task "Agentic HQ Attention Digest")
//   node tools/attention.mjs unmute <source>     - undo a demotion (5 dismissals in a row)
//   node tools/attention.mjs status              - today's count, budget, held items, per-source stats
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const attention = createRequire(import.meta.url)(path.join(ROOT, 'lib', 'attention.cjs'));
const [cmd, arg] = process.argv.slice(2).filter(a => a !== '--dry-run');
const DRY = process.argv.includes('--dry-run');

try {
  if (cmd === 'digest') {
    const result = await attention.runDigest({ dryRun: DRY });
    if (DRY && !result.skipped) console.log(`Would push: ${result.push.title}\n${result.push.message}\nClick: ${result.push.click}`);
    else console.log(JSON.stringify(result, null, 1));
  } else if (cmd === 'unmute' && arg) {
    const result = attention.unmute(arg);
    console.log(JSON.stringify(result, null, 1));
    if (!result.ok) process.exitCode = 1;
  } else if (cmd === 'status') {
    console.log(JSON.stringify(attention.status(), null, 1));
  } else {
    console.error('usage: node tools/attention.mjs digest [--dry-run] | unmute <source> | status');
    process.exitCode = 2;
  }
} catch (e) { console.error(e.message || e); process.exitCode = 3; }
