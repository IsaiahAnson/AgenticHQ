import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import places from '../../lib/places.cjs';
import { compact, fileStat, isMain, iso, runStandalone, walk } from './common.mjs';

const ROOT = path.join(places.workbench, 'handoffs');
const ALLOWED = new Set(['reports', 'specs', 'usage']);

function section(text, names, max) {
  const heading = new RegExp(`^#{1,6}\\s+(?:${names})\\s*$`, 'im').exec(text);
  if (!heading) return '';
  const rest = text.slice(heading.index + heading[0].length);
  return compact(rest.split(/^#{1,6}\s+/m)[0], max);
}

function dateFor(file, modified) {
  const bits = file.split(path.sep);
  for (const bit of bits.reverse()) {
    let match = bit.match(/(?:^|[^0-9])(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?:[^0-9]|$)/);
    if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return iso(modified)?.slice(0, 10) || null;
}

export async function extractHandoffs({ since }) {
  const files = await walk(ROOT, {
    extensions: new Set(['.md']),
    skip: (full, isDir) => isDir && path.dirname(full) === ROOT && !ALLOWED.has(path.basename(full).toLowerCase()),
  });
  const records = [];
  for (const file of files) {
    const info = await fileStat(file);
    if (!info) continue;
    const text = await readFile(file, 'utf8');
    const date = dateFor(file, info.mtime);
    if (new Date(`${date}T23:59:59Z`) < since) continue;
    records.push({
      path: path.relative(ROOT, file).replaceAll('\\', '/'),
      date,
      title: compact(text.match(/^#{1,6}\s+(.+)$/m)?.[1] || path.basename(file, '.md'), 200),
      result: section(text, 'Result|Summary|Verdict', 800) || compact(text.replace(/^---[\s\S]*?---\s*/, ''), 600),
      limits: section(text, 'Limits|Open(?: Questions)?|Risks', 400),
    });
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

if (isMain(import.meta.url)) await runStandalone('handoffs', extractHandoffs);
