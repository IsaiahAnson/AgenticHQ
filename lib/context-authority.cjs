'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const OS = path.resolve(__dirname, '..');
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
/* the shared knowledge folder: RUBRIC_KNOWLEDGE_DIR, else memoryDir under the root in config/workspace.json */
const WS = readJson(path.join(OS, 'config', 'workspace.json'));
const KNOWLEDGE = path.resolve(process.env.RUBRIC_KNOWLEDGE_DIR || path.resolve(OS, WS.root || os.homedir(), ...String(WS.memoryDir || 'knowledge').split('/')));
const POLICY = path.join(OS, 'config', 'context-authority.json');

function resolveCanonical(ref) {
  if (ref === 'installed:agenticos') return path.join(os.homedir(), '.claude', 'skills', 'agenticos', 'SKILL.md');
  if (ref.startsWith('knowledge:')) return path.join(KNOWLEDGE, path.basename(ref.slice(10)));
  /* "<name>:file" resolves in the folder that "folders" in config/context-authority.json names */
  const named = /^([a-z][\w-]*):(.+)$/.exec(ref), dir = named && readJson(POLICY).folders?.[named[1]];
  if (dir) return path.join(path.resolve(OS, dir), path.basename(named[2]));
  const file = path.resolve(OS, ref);
  if (file !== OS && !file.startsWith(OS + path.sep)) throw new Error(`Authority path escapes HQ: ${ref}`);
  return file;
}
function topicsFor(task) {
  const text = String(task).toLowerCase();
  const policy = JSON.parse(fs.readFileSync(POLICY, 'utf8'));
  return policy.topics.filter(topic => topic.terms.some(term => text.includes(term))).map(topic => ({
    id: topic.id, canonical: topic.canonical.map(ref => ({ path: resolveCanonical(ref), exists: fs.existsSync(resolveCanonical(ref)) })), live: topic.live
  }));
}
function verifiedDateFromBody(body) {
  const value = String(body || '').match(/^verified:\s*(\d{4}-\d{2}-\d{2})/m)?.[1] || null;
  return value && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ? value : null;
}
function auditKnowledge(now = new Date()) {
  const topics = JSON.parse(fs.readFileSync(POLICY, 'utf8')).topics;
  const missing = [], stale = [], duplicates = [];
  for (const topic of topics) for (const ref of topic.canonical) {
    const file = resolveCanonical(ref);
    if (!fs.existsSync(file)) missing.push({ topic: topic.id, path: file });
  }
  const hashes = new Map();
  if (fs.existsSync(KNOWLEDGE)) for (const name of fs.readdirSync(KNOWLEDGE).filter(x => x.endsWith('.md'))) {
    const file = path.join(KNOWLEDGE, name);
    if (name.toLowerCase() === 'memory.md') continue; // navigation index, not an operational claim
    const body = fs.readFileSync(file, 'utf8');
    const normalized = body.replace(/^---[\s\S]*?---\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized) {
      if (hashes.has(normalized)) duplicates.push({ first: hashes.get(normalized), second: file, kind: 'identical-body' });
      else hashes.set(normalized, file);
    }
    const verified = verifiedDateFromBody(body);
    if (!verified || (now.getTime() - Date.parse(`${verified}T00:00:00Z`)) / 86400000 > 30)
      stale.push({ path: file, verified: verified || null, reason: verified ? 'verification older than 30 days' : 'no verified date' });
  }
  return { checkedAt: now.toISOString(), missing, stale, duplicates, note: 'Candidates only. Verify against live sources before changing notes.' };
}
module.exports = { topicsFor, auditKnowledge, resolveCanonical, verifiedDateFromBody };
