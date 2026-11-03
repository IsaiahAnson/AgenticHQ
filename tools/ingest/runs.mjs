import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compact, fileStat, isMain, iso, OS_ROOT, runStandalone, walk } from './common.mjs';

function normalize(row, fallback = {}) {
  if (!row || typeof row !== 'object') return null;
  const status = String(row.status || row.state || row.outcome || fallback.status || '').toLowerCase();
  const startedAt = iso(row.startedAt || row.started || row.createdAt || row.timestamp || fallback.startedAt);
  const durationMs = Number(row.durationMs ?? row.duration ?? (row.endedAt && startedAt ? new Date(row.endedAt) - new Date(startedAt) : 0)) || 0;
  const failed = /fail|error|cancel/.test(status);
  const log = row.log || row.output || row.error || fallback.log || '';
  return {
    card: compact(row.card || row.cardId || row.skill || row.id || fallback.card || 'unknown', 160),
    status: compact(status || 'unknown', 40),
    startedAt,
    durationMs,
    reportRef: compact(row.reportRef || row.report || row.artifact || row.resultPath || fallback.reportRef || '', 300),
    ...(failed && log ? { failureTail: compact(String(log).slice(-300), 300) } : {}),
  };
}

async function endpointRows() {
  try {
    const response = await fetch('http://localhost:50000/api/outcomes', { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return [];
    const value = await response.json();
    return Array.isArray(value) ? value : value.outcomes || value.runs || [];
  } catch { return []; }
}

export async function extractRuns({ since }) {
  const rows = await endpointRows();
  const files = await walk(path.join(OS_ROOT, 'os-runs'), { extensions: new Set(['.json', '.jsonl']) });
  for (const file of files) {
    const info = await fileStat(file);
    if (!info || info.mtime < since) continue;
    const text = await readFile(file, 'utf8');
    for (const line of path.extname(file) === '.jsonl' ? text.split(/\r?\n/) : [text]) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (Array.isArray(value)) rows.push(...value); else rows.push(value);
      } catch { /* Ignore incomplete run records. */ }
    }
  }
  return rows.map((row) => normalize(row)).filter((row) => row && (!row.startedAt || new Date(row.startedAt) >= since))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.card.localeCompare(b.card));
}

if (isMain(import.meta.url)) await runStandalone('runs', extractRuns);
