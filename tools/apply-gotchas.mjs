#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyProposals } = require('../lib/gotcha-proposals.cjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const value = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : null; };
const optionValues = new Set(['--skills-root', '--data-file'].flatMap(name => { const at = process.argv.indexOf(name); return at >= 0 ? [name, process.argv[at + 1]] : []; }));
const ids = process.argv.slice(2).filter(arg => !arg.startsWith('--') && !optionValues.has(arg));
if (!ids.length) { console.error('usage: node tools/apply-gotchas.mjs <id...> [--skills-root <dir>] [--data-file <file>] [--no-commit]'); process.exit(2); }
const result = applyProposals({ ids, skillsRoot: value('--skills-root') || path.join(os.homedir(), '.claude', 'skills'), dataFile: value('--data-file') || path.join(ROOT, 'data', 'gotcha-proposals.json'), commit: !process.argv.includes('--no-commit') });
console.log(JSON.stringify(result, null, 2));
