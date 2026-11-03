import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { compact, fileStat, isMain, iso, OS_ROOT, runStandalone, walk } from './common.mjs';
import { redact } from './redact.mjs';

const exec = promisify(execFile);
const ROOTS = [
  ['notes', path.join(os.homedir(), 'Documents', 'Notes & Guides')],
  ['resume', path.join(os.homedir(), 'Documents', 'Resumes')],
];
const EXTENSIONS = new Set(['.txt', '.md', '.html', '.jsx', '.docx', '.pdf']);
// Files that must never be read (saved sign-ins and the like): the file names listed in config/workspace.json skipPaths.
function skipFileNames() {
  try {
    const { skipPaths = [] } = JSON.parse(readFileSync(path.join(OS_ROOT, 'config', 'workspace.json'), 'utf8'));
    return skipPaths.map(p => path.basename(String(p))).filter(name => path.extname(name)).map(name => name.toLowerCase());
  } catch { return []; }
}
const SKIP_FILES = new Set(skipFileNames());

function plainText(text) {
  return String(text || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/(?<!\w)\d{1,6}\s+[A-Za-z0-9.' -]{2,50}\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b[^\n,]*/gi, '[redacted]')
    .replace(/\s+/g, ' ').trim();
}

async function docxText(file) {
  const escaped = file.replaceAll("'", "''");
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${escaped}'); try{$e=$z.GetEntry('word/document.xml'); if($e){$r=New-Object IO.StreamReader($e.Open()); try{$r.ReadToEnd()}finally{$r.Dispose()}}}finally{$z.Dispose()}`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  try { return (await exec('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { maxBuffer: 12 * 1024 * 1024, windowsHide: true })).stdout; } catch { return null; }
}

async function pdfText(file) {
  const code = "import sys; from pypdf import PdfReader; print('\\n'.join((p.extract_text() or '') for p in PdfReader(sys.argv[1]).pages))";
  try { return (await exec('python', ['-c', code, file], { maxBuffer: 12 * 1024 * 1024, windowsHide: true })).stdout; } catch { return null; }
}

function filenameDate(file) {
  const name = path.basename(file);
  const yearFirst = name.match(/(20\d{2})[-_. ]([01]?\d)(?:[-_. ]([0-3]?\d))?/);
  if (yearFirst) return new Date(Date.UTC(Number(yearFirst[1]), Number(yearFirst[2]) - 1, Number(yearFirst[3] || 1))).valueOf();
  const monthFirst = name.match(/(?:^|\D)([01]?\d)[-_. ]([0-3]?\d)[-_. ](20\d{2})(?:\D|$)/);
  if (monthFirst) return new Date(Date.UTC(Number(monthFirst[3]), Number(monthFirst[1]) - 1, Number(monthFirst[2]))).valueOf();
  return 0;
}

export async function extractDocs({ since }) {
  const candidates = [];
  for (const [kind, root] of ROOTS) {
    let files = (await walk(root, { extensions: EXTENSIONS })).filter(f => !SKIP_FILES.has(path.basename(f).toLowerCase()));
    if (kind === 'resume') files = files.sort((a, b) => filenameDate(b) - filenameDate(a)).slice(0, 3);
    for (const file of files) {
      const info = await fileStat(file);
      if (info && info.mtime >= since) candidates.push({ file, root, kind, info });
    }
  }
  const seenSize = new Set();
  const seenHash = new Set();
  const records = [];
  for (const item of candidates.sort((a, b) => b.info.mtime - a.info.mtime || a.file.localeCompare(b.file))) {
    if (/\s\(1\)(?=\.[^.]+$)/i.test(item.file) || seenSize.has(item.info.size)) continue;
    const bytes = await readFile(item.file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (seenHash.has(hash)) continue;
    seenSize.add(item.info.size); seenHash.add(hash);
    const ext = path.extname(item.file).toLowerCase();
    let raw = null;
    if (['.txt', '.md', '.html', '.jsx'].includes(ext)) raw = bytes.toString('utf8');
    else if (ext === '.docx') raw = await docxText(item.file);
    else if (ext === '.pdf') raw = await pdfText(item.file);
    const record = {
      path: path.relative(item.root, item.file).replaceAll('\\', '/'),
      kind: item.kind,
      modified: iso(item.info.mtime),
      chars: raw == null ? 0 : plainText(raw).length,
    };
    if (raw == null) record.textUnavailable = true;
    else record.text = redact(plainText(raw)).slice(0, 6000);
    records.push(record);
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}

if (isMain(import.meta.url)) await runStandalone('docs', extractDocs);
