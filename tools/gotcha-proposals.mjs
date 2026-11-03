#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildProposals } = require('../lib/gotcha-proposals.cjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
let result;
// A bad source read throws before anything is written; say so plainly instead of dumping a stack.
try { result = buildProposals({ root: ROOT, dryRun: process.argv.includes('--dry-run') }); }
catch (error) { console.error(`gotcha-proposals: ${error.message} (nothing was written)`); process.exit(1); }
console.log(JSON.stringify({ dryRun: result.dryRun, proposalCount: result.proposals.length, candidateCount: result.candidateCount,
  report: result.report?.htmlName || null, top: result.top?.map(({ rank, tier, score, category, title }) => ({ rank, tier, score, skill: category, text: title })) || [],
  proposals: result.proposals.map(({ id, skill, text, source }) => ({ id, skill, text, source })) }, null, 2));
