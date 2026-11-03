import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import places from '../../lib/places.cjs';
import { redact, redactObject } from './redact.mjs';

export const OS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STAGING = path.join(places.companions, 'data', 'ingest');
export const STATE_FILE = path.join(STAGING, 'state.json');

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { dryRun: false, since: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--since') options.since = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (options.since && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) throw new Error('--since must be YYYY-MM-DD');
  return options;
}

export async function readState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}

export function resolveSince(name, options, state) {
  const fallback = new Date(Date.now() - 14 * 86400000).toISOString();
  const raw = options.since || state[name] || fallback;
  const date = new Date(options.since ? `${raw}T00:00:00.000Z` : raw);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid watermark for ${name}`);
  return date;
}

export async function* jsonLines(file) {
  const input = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* Ignore incomplete/corrupt log lines. */ }
  }
}

export async function walk(root, { extensions, skip = () => false, maxDepth = Infinity } = {}) {
  const found = [];
  async function visit(dir, depth) {
    if (depth > maxDepth || skip(dir, true)) return;
    let entries;
    try { entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true })); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (skip(full, entry.isDirectory())) continue;
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (!extensions || extensions.has(path.extname(entry.name).toLowerCase())) found.push(full);
    }
  }
  await visit(root, 0);
  return found;
}

export function compact(value, max) {
  return redact(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max);
}

export function iso(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function jsonl(records) {
  return records.map((record) => JSON.stringify(redactObject(record))).join('\n') + (records.length ? '\n' : '');
}

export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, file);
}

export async function runStandalone(name, extract) {
  const options = parseArgs();
  const state = await readState();
  const since = resolveSince(name, options, state);
  const records = await extract({ since });
  const content = jsonl(records);
  const day = new Date().toISOString().slice(0, 10);
  const output = path.join(STAGING, day, `${name}.jsonl`);
  if (!options.dryRun) {
    await atomicWrite(output, content);
    state[name] = new Date().toISOString();
    await atomicWrite(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  }
  console.log(JSON.stringify({ extractor: name, count: records.length, bytes: Buffer.byteLength(content), since: since.toISOString(), output: options.dryRun ? null : output, dryRun: options.dryRun }));
}

export function isMain(metaUrl) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}

export async function fileStat(file) {
  try { return await stat(file); } catch { return null; }
}
