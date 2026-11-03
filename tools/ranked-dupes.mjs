import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { duplicateReport, nearDuplicatePairs, repeatAlert } = require('../lib/ranked-dupes.cjs');
/* local add-ons add views (addon.json "rankedViews", lib/addons.cjs); one marked hideText never prints its item text */
const addonViews = require('../lib/addons.cjs').manifests(fileURLToPath(new URL('..', import.meta.url))).flatMap(addon => addon.rankedViews);
const hidden = new Set(addonViews.filter(view => view.hideText).map(view => view.endpoint));
const endpoints = [
  '/api/learned/standings?status=ranked&limit=500',
  '/api/learned/standings?status=all&limit=500',
  '/api/learned',
  '/api/radar/standings?status=ranked&limit=500',
  '/api/radar/standings?status=all&limit=500',
  ...addonViews.map(view => view.endpoint)
];
const args = process.argv.slice(2);
let base = 'http://localhost:50000', json = false, showText = false, alert = false;
let log = fileURLToPath(new URL('../os-runs/ranked-dupes.jsonl', import.meta.url));
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base' && args[i + 1]) base = args[++i];
  else if (args[i] === '--json') json = true;
  else if (args[i] === '--show-text') showText = true;
  else if (args[i] === '--alert') alert = true;
  else if (args[i] === '--log' && args[i + 1]) log = args[++i];
  else {
    console.error('Usage: node tools/ranked-dupes.mjs [--base URL] [--json] [--show-text] [--alert [--log FILE]]');
    process.exit(2);
  }
}

async function readView(endpoint) {
  try {
    const response = await fetch(new URL(endpoint, base), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const lists = endpoint === '/api/learned'
      ? [{ items: body.pending, textOf: item => item.text }, { items: body.standings?.items }]
      : [{ items: body.items }];
    if (lists.some(list => !Array.isArray(list.items))) throw new Error('Invalid response');
    const row = { endpoint, ok: true, total: 0, unique: 0, duplicateTexts: 0, extraCopies: 0, nearPairs: 0 };
    const texts = new Set();
    for (const { items, textOf } of lists) {
      const report = duplicateReport(items, { textOf });
      for (const field of ['total', 'unique', 'duplicateTexts', 'extraCopies']) row[field] += report[field];
      row.nearPairs += nearDuplicatePairs(items, { textOf }).length;
      for (const group of report.groups) texts.add(group.key);
    }
    if (showText && !hidden.has(endpoint)) row.texts = [...texts];
    return row;
  } catch (err) {
    // Keep the reason, so a busy server or a parse slip doesn't read as "HQ is down". A JSON error quotes the body,
    // which can hold a hidden view's text, so it is never shown. "fetch failed" keeps its socket code (reset, refused) from err.cause.
    const code = err?.cause?.code ? ` (${err.cause.code})` : '';
    const error = err?.name === 'SyntaxError' ? 'Response was not JSON' : String(err?.message || err).slice(0, 180) + code;
    return { endpoint, ok: false, error, total: null, unique: null, duplicateTexts: null, extraCopies: null, nearPairs: null };
  }
}

const rows = [];
for (const endpoint of endpoints) rows.push(await readView(endpoint));
// A view that failed gets one more read after a short pause, so a blip doesn't count as a failure: on 2026-11-02 one
// /api/learned read got "fetch failed" while the other six views read fine, and the next read worked. firstError keeps
// the first reason in --json and the run log. RANKED_DUPES_RETRY_MS shortens the pause for tests.
if (rows.some(row => !row.ok)) {
  await new Promise(resolve => setTimeout(resolve, Number(process.env.RANKED_DUPES_RETRY_MS) || 2000));
  for (const [i, row] of rows.entries()) if (!row.ok) rows[i] = { ...await readView(row.endpoint), firstError: row.error };
}
if (json) console.log(JSON.stringify(rows, null, 2));
else {
  console.log('endpoint | ok | total | unique | duplicates | extra | near');
  for (const row of rows) {
    console.log(`${row.endpoint} | ${row.ok} | ${row.total ?? '-'} | ${row.unique ?? '-'} | ${row.duplicateTexts ?? '-'} | ${row.extraCopies ?? '-'} | ${row.nearPairs ?? '-'}`);
    if (row.firstError) console.log(`  first read failed: ${row.firstError}`);
    if (row.error) console.log(`  failed: ${row.error}`);
    if (row.texts?.length) console.log(`  ${row.texts.join(' | ')}`);
  }
}
process.exitCode = rows.some(row => !row.ok) ? 2 : rows.some(row => row.duplicateTexts) ? 1 : 0;

// --alert is the daily Agentic HQ Repeat Check: at most one push or digest line a day through the attention gate,
// and one line per run in os-runs/ranked-dupes.jsonl. Both hold view names and counts, never item text.
if (alert) {
  const attention = require('../lib/attention.cjs');
  const found = repeatAlert(rows);
  let outcome = null;
  if (found) {
    try {
      const result = await attention.notify({ source: 'ranked-dupes', ...found, key: `ranked-dupes:${attention.localDay(Date.now())}:${found.priority}`, click: 'http://localhost:50000/' });
      outcome = { priority: found.priority, reason: result.reason, sent: result.sent };
    } catch (err) {
      outcome = { priority: found.priority, error: String(err?.message || err).slice(0, 200) };
      console.error(`ranked-dupes: the alert failed: ${outcome.error}`);
    }
  }
  mkdirSync(dirname(log), { recursive: true });
  appendFileSync(log, JSON.stringify({ ts: new Date().toISOString(), base, rows: rows.map(({ texts, ...row }) => row), alert: outcome }) + '\n', 'utf8');
}
