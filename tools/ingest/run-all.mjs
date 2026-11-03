import path from 'node:path';
import { atomicWrite, jsonl, parseArgs, readState, resolveSince, STAGING } from './common.mjs';
import { extractCommits } from './commits.mjs';
import { extractDocs } from './docs.mjs';
import { extractHandoffs } from './handoffs.mjs';
import { extractRuns } from './runs.mjs';
import { extractSessions } from './sessions.mjs';

const EXTRACTORS = [
  ['sessions', extractSessions],
  ['handoffs', extractHandoffs],
  ['runs', extractRuns],
  ['commits', extractCommits],
  ['docs', extractDocs],
];

const options = parseArgs();
const previous = await readState();
const completedAt = new Date().toISOString();
const day = completedAt.slice(0, 10);
const outputs = [];
const nextState = { ...previous };

for (const [name, extract] of EXTRACTORS) {
  const since = resolveSince(name, options, previous);
  const records = await extract({ since });
  const content = jsonl(records);
  outputs.push({ name, since: since.toISOString(), records, content, count: records.length, bytes: Buffer.byteLength(content) });
  nextState[name] = completedAt;
}

const totalBytes = outputs.reduce((sum, item) => sum + item.bytes, 0);
if (totalBytes > 2 * 1024 * 1024) throw new Error(`Daily ingest is ${totalBytes} bytes, above the 2 MiB safety target`);

const manifest = {
  generatedAt: completedAt,
  day,
  dryRun: options.dryRun,
  totalBytes,
  extractors: Object.fromEntries(outputs.map((item) => [item.name, { count: item.count, bytes: item.bytes, watermark: item.since }])),
};

if (!options.dryRun) {
  for (const item of outputs) await atomicWrite(path.join(STAGING, day, `${item.name}.jsonl`), item.content);
  await atomicWrite(path.join(STAGING, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await atomicWrite(path.join(STAGING, 'state.json'), `${JSON.stringify(nextState, null, 2)}\n`);
}

console.log(JSON.stringify(manifest, null, 2));
