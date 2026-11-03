import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compact, fileStat, isMain, iso, jsonLines, OS_ROOT, runStandalone, walk } from './common.mjs';

const CLAUDE_ROOT = path.join(os.homedir(), '.claude', 'projects');
const CODEX_ROOT = path.join(os.homedir(), '.codex', 'sessions');
/* a session that mentions one of these words keeps only its id and times: os-config.json ingest.privateWords */
const PRIVATE_WORDS = await readFile(path.join(OS_ROOT, 'os-config.json'), 'utf8').then(text => JSON.parse(text).ingest?.privateWords, () => null)
  || ['medical', 'diagnosis', 'ssn', 'passport', 'lawsuit', 'refund', 'dispute', 'invoice', 'payment', 'tax'];
const SENSITIVE = new RegExp(`\\b(${PRIVATE_WORDS.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
const NOISE = /chat[- ]title|branch[- ]name|reply with exactly|security[- ]review/i;

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item && (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text')).map((item) => item.text || item.content || '');
}

function projectName(cwd, file, root) {
  if (cwd) return path.basename(cwd.replace(/[\\/]$/, '')) || cwd;
  const relative = path.relative(root, file).split(path.sep)[0];
  return relative.replace(/^[A-Z]--/i, '').replace(/-/g, '_') || 'unknown';
}

function addSkill(set, text) {
  for (const match of String(text || '').matchAll(/(?:skills?[\\/]|\$)([a-z][a-z0-9_-]{2,})(?:[\\/]SKILL\.md)?/gi)) set.add(match[1].toLowerCase());
}

async function parseSession(file, agent, root) {
  const data = { users: [], assistants: [], errors: 0, files: new Set(), skills: new Set(), timestamps: [], cwd: '', id: path.basename(file, '.jsonl') };
  for await (const row of jsonLines(file)) {
    const timestamp = iso(row.timestamp || row.payload?.timestamp);
    if (timestamp) data.timestamps.push(timestamp);
    if (row.sessionId || row.payload?.session_id || row.payload?.id) data.id = row.sessionId || row.payload.session_id || row.payload.id;
    data.cwd ||= row.cwd || row.payload?.cwd || '';
    if (agent === 'claude') {
      const role = row.message?.role || row.type;
      const texts = textParts(row.message?.content);
      if (role === 'user' && texts.length) data.users.push(texts.join(' '));
      if (role === 'assistant' && texts.length) data.assistants.push(texts.join(' '));
      for (const item of Array.isArray(row.message?.content) ? row.message.content : []) {
        if (item.type === 'tool_result' && (item.is_error || /error/i.test(String(item.content || '')))) data.errors += 1;
        if (item.type === 'tool_use') {
          const name = String(item.name || '');
          if (/^(Edit|Write)$/i.test(name)) {
            const target = item.input?.file_path || item.input?.path;
            if (target) data.files.add(String(target));
          }
          if (/skill/i.test(name)) addSkill(data.skills, JSON.stringify(item.input || {}));
        }
      }
    } else {
      const payload = row.payload || {};
      if (row.type === 'event_msg' && payload.type === 'user_message') data.users.push(payload.message || payload.text || '');
      if (row.type === 'event_msg' && /agent_message|assistant_message/.test(payload.type)) data.assistants.push(payload.message || payload.text || '');
      if (row.type === 'response_item' && payload.type === 'message') {
        const texts = textParts(payload.content);
        if (payload.role === 'user' && texts.length) data.users.push(texts.join(' '));
        if (payload.role === 'assistant' && texts.length) data.assistants.push(texts.join(' '));
      }
      if (row.type === 'response_item' && /function_call/.test(payload.type || '')) {
        let args = payload.arguments || payload.input || {};
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
        if (/^(apply_patch|write_file|edit_file)$/i.test(payload.name || '')) {
          const target = args.file_path || args.path;
          if (target) data.files.add(String(target));
        }
        addSkill(data.skills, JSON.stringify(args));
      }
      if (/error|failed/.test(payload.type || '') || row.type === 'error') data.errors += 1;
    }
  }
  data.users = data.users.map((item) => compact(item, 10000)).filter(Boolean);
  data.assistants = data.assistants.map((item) => compact(item, 10000)).filter(Boolean);
  const allText = [...data.users, ...data.assistants].join('\n');
  if (data.users.length < 2 || NOISE.test(data.users[0] || '')) return null;
  const base = { id: data.id, agent, project: projectName(data.cwd, file, root), started: data.timestamps[0] || null, ended: data.timestamps.at(-1) || null };
  if (SENSITIVE.test(allText)) return { id: base.id, project: base.project, started: base.started, ended: base.ended, sensitive: true };
  return {
    ...base,
    firstPrompt: compact(data.users[0], 500),
    followUps: data.users.slice(1, 9).map((item) => compact(item, 200)),
    outcome: compact(data.assistants.at(-1), 1200),
    toolErrors: data.errors,
    filesTouched: [...data.files].slice(0, 20),
    skillsUsed: [...data.skills].sort(),
  };
}

export async function extractSessions({ since }) {
  const sources = [
    ['claude', CLAUDE_ROOT, (full, isDir) => isDir && path.basename(full).toLowerCase() === 'subagents'],
    ['codex', CODEX_ROOT, () => false],
  ];
  const records = [];
  for (const [agent, root, skip] of sources) {
    for (const file of await walk(root, { extensions: new Set(['.jsonl']), skip })) {
      const info = await fileStat(file);
      if (!info || info.mtime < since) continue;
      const record = await parseSession(file, agent, root);
      if (record && (!record.ended || new Date(record.ended) >= since)) records.push(record);
    }
  }
  return records.sort((a, b) => String(a.started).localeCompare(String(b.started)) || a.id.localeCompare(b.id));
}

if (isMain(import.meta.url)) await runStandalone('sessions', extractSessions);
