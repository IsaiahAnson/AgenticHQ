#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STAMP = /^(.*)-(20\d{2}(?:\d{4}|-\d{2}-\d{2})(?:[-T]\d{4}(?:\d{2})?)?)$/;

export function stampedReport(filename) {
  if (path.extname(filename).toLowerCase() !== '.html') return null;
  const stem = path.basename(filename, path.extname(filename));
  const match = stem.match(STAMP);
  if (!match || !match[1]) return null;
  const sortKey = match[2].replace(/\D/g, '').padEnd(14, '0');
  const shape = /^20\d{2}-\d{2}-\d{2}$/.test(match[2]) ? 'daily' : 'run';
  return { family: `${match[1]}:${shape}`, stamp: match[2], sortKey };
}

function existingPair(dir, stem) {
  return ['.html', '.json'].map(ext => path.join(dir, `${stem}${ext}`)).filter(fs.existsSync);
}

export function planRetention(artifactsDir, { now = Date.now(), trashDays = 30 } = {}) {
  const trashDir = path.join(artifactsDir, '_trash');
  const families = new Map();
  for (const entry of fs.readdirSync(artifactsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const report = stampedReport(entry.name);
    if (!report) continue;
    const stem = path.basename(entry.name, path.extname(entry.name));
    const row = { ...report, stem, mtimeMs: fs.statSync(path.join(artifactsDir, entry.name)).mtimeMs };
    if (!families.has(report.family)) families.set(report.family, []);
    families.get(report.family).push(row);
  }

  const moves = [];
  for (const rows of families.values()) {
    rows.sort((a, b) => b.sortKey.localeCompare(a.sortKey) || b.mtimeMs - a.mtimeMs || b.stem.localeCompare(a.stem));
    for (const row of rows.slice(1)) {
      for (const source of existingPair(artifactsDir, row.stem)) {
        moves.push({ source, destination: path.join(trashDir, path.basename(source)) });
      }
    }
  }

  const deletes = [];
  const cutoff = now - trashDays * 86400000;
  if (fs.existsSync(trashDir)) {
    for (const entry of fs.readdirSync(trashDir, { withFileTypes: true })) {
      if (!entry.isFile() || !stampedReport(entry.name)) continue;
      const html = path.join(trashDir, entry.name);
      if (fs.statSync(html).mtimeMs >= cutoff) continue;
      const stem = path.basename(entry.name, path.extname(entry.name));
      deletes.push(...existingPair(trashDir, stem));
    }
  }

  return { artifactsDir, trashDir, families: families.size, moves, deletes: [...new Set(deletes)] };
}

export function applyRetention(plan, { now = new Date() } = {}) {
  if (plan.moves.length) fs.mkdirSync(plan.trashDir, { recursive: true });
  for (const move of plan.moves) {
    if (fs.existsSync(move.destination)) fs.rmSync(move.destination);
    fs.renameSync(move.source, move.destination);
    fs.utimesSync(move.destination, now, now);
  }
  for (const file of plan.deletes) fs.rmSync(file, { force: true });
}

export function formatPlan(plan, dryRun = false) {
  const lines = [`Artifact retention${dryRun ? ' dry run' : ''}: ${plan.families} stamped families, ${plan.moves.length} files to trash, ${plan.deletes.length} files to delete.`];
  for (const move of plan.moves) lines.push(`MOVE ${path.basename(move.source)} -> artifacts/_trash/`);
  for (const file of plan.deletes) lines.push(`DELETE artifacts/_trash/${path.basename(file)}`);
  if (!plan.moves.length && !plan.deletes.length) lines.push('No changes.');
  return lines.join('\n');
}

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const unknown = process.argv.slice(2).filter(arg => arg !== '--dry-run');
  if (unknown.length) {
    console.error('Usage: node tools/artifact-retention.mjs [--dry-run]');
    process.exitCode = 2;
  } else {
    const dryRun = process.argv.includes('--dry-run');
    const artifactsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
    const plan = planRetention(artifactsDir);
    console.log(formatPlan(plan, dryRun));
    if (!dryRun) applyRetention(plan);
  }
}
