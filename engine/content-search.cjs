'use strict';
const fs = require('fs');
const path = require('path');
const scan = require('./scan');

const EXT = new Set(['.md', '.txt', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.json', '.yaml', '.yml', '.toml', '.ps1', '.html', '.css', '.go', '.rs', '.java', '.sql']);
const SKIP = /(^|\/)(data|os-runs|artifacts|snapshots|node_modules|dist|coverage|\.git|graphify-out)(\/|$)|\.bak(?:[-.]|$)|(^|\/)brain\/snapshot/i;
const MAX_FILE = 120 * 1024;
const MAX_TOTAL = 96 * 1024 * 1024;
const STOP = new Set(['the', 'and', 'for', 'how', 'does', 'what', 'with', 'from', 'this', 'that', 'into', 'are', 'can', 'agentic', 'hq']);
const wordsOf = q => [...new Set(String(q).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) || [])].filter(x => !STOP.has(x)).slice(0, 7);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function buildContentIndex(model, root) {
  const documents = [];
  let bytes = 0, eligible = 0, skipped = 0, truncated = false;
  const rootReal = fs.realpathSync(root);
  for (const f of model.files) {
    if (!EXT.has(f.ext) || f.size > MAX_FILE || f.size < 1 || SKIP.test(f.rel) || scan.isSecret(f.rel)) continue;
    eligible++;
    if (bytes + f.size > MAX_TOTAL) { truncated = true; skipped++; continue; }
    const abs = path.resolve(root, f.rel);
    try {
      if (!inside(root, abs) || !inside(rootReal, fs.realpathSync(abs))) { skipped++; continue; }
      const content = fs.readFileSync(abs, 'utf8');
      if (content.includes('\0')) { skipped++; continue; }
      documents.push({ path: f.rel, content, lower: content.toLowerCase(), modifiedAt: new Date(f.mtime).toISOString() });
      bytes += Buffer.byteLength(content);
    } catch { skipped++; }
  }
  return { documents, coverage: { indexed: documents.length, eligible, skipped, bytes, truncated } };
}

function searchContent(index, query, limit = 10) {
  const words = wordsOf(query);
  if (!words.length) return [];
  const scored = [];
  for (const doc of index.documents) {
    const pathLower = doc.path.toLowerCase();
    const matches = words.filter(w => doc.lower.includes(w));
    if (!matches.length) continue;
    let bestLine = -1, best = 0;
    const lines = doc.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      const score = words.filter(w => line.includes(w)).length;
      if (score > best) { best = score; bestLine = i; }
    }
    if (bestLine < 0) continue;
    const score = matches.length * 12 + best * 8 + words.filter(w => pathLower.includes(w)).length * 9
      + (pathLower.includes('/knowledge/') ? 8 : 0) - Math.min(8, doc.path.split('/').length);
    scored.push({ path: doc.path, line: bestLine + 1, score, modifiedAt: doc.modifiedAt,
      excerpt: lines.slice(Math.max(0, bestLine - 1), Math.min(lines.length, bestLine + 4)).join('\n').slice(0, 650) });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(30, Math.max(1, limit)));
}

module.exports = { buildContentIndex, searchContent, wordsOf };
