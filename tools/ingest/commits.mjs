import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import places from '../../lib/places.cjs';
import { compact, isMain, OS_ROOT, runStandalone, walk } from './common.mjs';

const exec = promisify(execFile);
const PROJECTS = path.join(os.homedir(), 'Projects');
/* os-config.json ingest.extraRepos: repo folders in the home folder, outside Projects, whose commits count too */
const EXTRA = await readFile(path.join(OS_ROOT, 'os-config.json'), 'utf8')
  .then(text => JSON.parse(text).ingest?.extraRepos || [], () => [])
  .then(names => names.map(name => path.join(os.homedir(), name)));
const COMPANION_DATA = path.join(places.companions, 'data').toLowerCase();

async function isRepo(dir) {
  try { return (await stat(path.join(dir, '.git'))).isDirectory(); } catch { return false; }
}

async function discover() {
  const repos = new Set();
  const skipName = (name) => ['node_modules', '.git', '.claude', 'data'].includes(name.toLowerCase());
  async function visit(dir, depth) {
    if (depth > 2 || skipName(path.basename(dir))) return;
    if (await isRepo(dir)) { repos.add(dir); return; }
    let entries;
    try { entries = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true })); } catch { return; }
    for (const entry of entries) if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
  }
  await visit(PROJECTS, 0);
  for (const dir of EXTRA) if (await isRepo(dir)) repos.add(dir);
  return [...repos].sort();
}

async function repoCommits(repo, since) {
  const marker = '__INGEST_COMMIT__';
  let stdout;
  try {
    ({ stdout } = await exec('git', ['-C', repo, 'log', '--no-merges', `--since=${since.toISOString()}`, `--format=${marker}%aI%x1f%s%x1f%b%x1e`, '--numstat'], { maxBuffer: 8 * 1024 * 1024, windowsHide: true }));
  } catch { return []; }
  const commits = [];
  for (const block of stdout.split(marker).slice(1)) {
    const separator = block.indexOf('\x1e');
    const header = separator >= 0 ? block.slice(0, separator) : block;
    const stats = separator >= 0 ? block.slice(separator + 1) : '';
    const [date = '', subject = '', bodyRaw = ''] = header.split('\x1f');
    let files = 0, insertions = 0, deletions = 0;
    for (const line of stats.trim().split(/\r?\n/)) {
      const match = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
      if (!match) continue;
      files += 1;
      insertions += match[1] === '-' ? 0 : Number(match[1]);
      deletions += match[2] === '-' ? 0 : Number(match[2]);
    }
    commits.push({ date: date.trim(), subject: compact(subject, 300), body: compact(bodyRaw.split(/\r?\n/).slice(0, 3).join(' '), 300), files, insertions, deletions });
  }
  return commits;
}

export async function extractCommits({ since }) {
  const records = [];
  for (const repo of await discover()) {
    if (path.resolve(repo).toLowerCase().startsWith(COMPANION_DATA) ||/\\\.claude\\worktrees(?:\\|$)/i.test(repo)) continue;
    const commits = await repoCommits(repo, since);
    if (commits.length) records.push({ repo: path.basename(repo), commits });
  }
  return records;
}

if (isMain(import.meta.url)) await runStandalone('commits', extractCommits);
