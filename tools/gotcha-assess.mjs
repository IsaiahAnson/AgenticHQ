#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const standings = require('../lib/standings.cjs');
const assess = require('../lib/gotcha-assess.cjs');
const { writeReport, atomicWrite, stateDefault } = require('../lib/gotcha-proposals.cjs');
const { withLock } = require('../lib/store-lock.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function valueAfter(flag) { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; }

const inputFile = valueAfter('--file'), wantsPacket = process.argv.includes('--packet'), json = process.argv.includes('--json');
const dataDir = valueAfter('--data-dir') ? path.resolve(valueAfter('--data-dir')) : path.join(ROOT, 'data');
const STORE_FILE = path.join(dataDir, 'standings', 'learned.json');
if (process.argv.includes('--missing')) {
  // Retired legacy step. A running HQ keeps the old Gotcha card prompt (which calls --missing) in memory until it
  // restarts, so answer "nothing missing" rather than fail that run; judging now runs from --packet.
  console.error('gotcha-assess: --missing is retired; the judge runs from --packet. Restart HQ to load the new Gotcha card prompt.');
  console.log(json ? '[]' : 'Missing assessments: 0');
} else if ((inputFile ? 1 : 0) + (wantsPacket ? 1 : 0) !== 1) {
  console.error('Usage: node tools/gotcha-assess.mjs --packet [--json] [--batch N] | --file <json>'); process.exitCode = 2;
} else {
  if (wantsPacket) {
    const store = standings.load(STORE_FILE, 'learned');
    const batch = Number(valueAfter('--batch') || 40), result = assess.packet(store, { batch });
    if (json) console.log(JSON.stringify(result, null, 2));
    else { console.log('What HQ Learned judge packet'); console.log(JSON.stringify(result.rubric, null, 2)); console.log(`Items: ${result.items.length}`); console.log(JSON.stringify(result.items, null, 2)); }
  } else {
    withLock(STORE_FILE, () => {
    const store = standings.load(STORE_FILE, 'learned'), proposalsFile = path.join(dataDir, 'gotcha-proposals.json');
    const input = readJson(path.resolve(inputFile));
    const merges = Array.isArray(input?.assessments) && input.assessments.some(a => a?.mergeInto);
    const state = merges && fs.existsSync(proposalsFile) ? readJson(proposalsFile) : stateDefault();
    const result = assess.applyJudgments(store, input, { now: new Date(), state });
    if (result.problems.length) { for (const problem of result.problems) console.error(problem); process.exitCode = 1; }
    else {
      // A merge folds two items into one entry; the proposals it made redundant are recorded as merged.
      if (result.state) atomicWrite(proposalsFile, JSON.stringify(result.state, null, 2) + '\n');
      standings.save(STORE_FILE, result.store);
      const latest = result.store.runs.at(-1), report = writeReport({ artifactsDir: path.join(valueAfter('--data-dir') ? path.dirname(dataDir) : ROOT, 'artifacts'), store: result.store, generatedAt: new Date().toISOString(), reportName: latest?.report });
      console.log(JSON.stringify({ judged: result.judged, uncritiqued: result.uncritiqued, report: report.htmlName, top: standings.view(result.store, { status: 'ranked', limit: 3 }).items.map(i => ({ id: i.id, reason: i.reason })) }, null, 2));
    }
    });
  }
}
