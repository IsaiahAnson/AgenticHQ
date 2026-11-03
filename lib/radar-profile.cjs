'use strict';
// AI Radar profile: a short, non-private digest of what Agentic HQ is and what it needs, used in every radar prompt.
//   buildProfile(facts, config) -> { digest, keywords }   (pure; digest <= 1,500 chars, redacted)
//   gatherFacts({ hqUrl, kit, fetchImpl }) -> facts from live /api/apps, /api/skills, /api/health, /api/routines,
//   falling back to os-config.json when HQ is down. Failure-registry rows contribute titles (fingerprints) only.
// Redaction: no user-profile paths beyond a repo name, no emails, nothing shaped like a key or token.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT = path.resolve(__dirname, '..');
const REGISTRY = path.join(require('./places.cjs').companions, 'knowledge', 'hq-failure-registry.md');
const MAX_DIGEST = 1500;
const OPEN_STATUSES = new Set(['proposed', 'active', 'watching']);
const WORKER_LANES = ['Claude Code', 'Codex CLI', 'Copilot CLI', 'OpenCode', 'DeepSeek web (Orca browser)', 'Kilo'];

// Replace private paths with their repo name, and drop emails and anything shaped like a credential.
function redact(text) {
  return String(text ?? '')
    .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|]+((?:[\\/]+[^\\/\s"'`<>|]+)*)/g, (_, rest) => {
      const parts = String(rest || '').split(/[\\/]+/).filter(Boolean);
      const i = parts.findIndex(p => /^projects$/i.test(p));
      return i >= 0 && parts[i + 1] ? parts[i + 1] : '[path]';
    })
    .replace(/(?:~|\$HOME|%USERPROFILE%)[\\/][^\s"'`<>|]*/gi, '[path]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, '[redacted]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]');
}

// Titles (fingerprints) of failure-registry rows that are still open or watched.
function parseFailureRegistry(md) {
  const out = [];
  for (const line of String(md || '').split(/\r?\n/)) {
    if (!/^\|\s*`[^`]+`\s*\|/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const status = String(cells[8] || '').toLowerCase().replace(/`/g, '');
    if (OPEN_STATUSES.has(status)) out.push(cells[0].replace(/`/g, ''));
  }
  return out;
}

const clean = (v, n = 60) => redact(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);
const uniq = list => [...new Set(list.filter(Boolean))];

function joinCapped(label, list, budget) {
  const items = uniq(list);
  if (!items.length) return '';
  let s = label + ': ';
  for (let i = 0; i < items.length; i++) {
    const next = (i ? ', ' : '') + items[i];
    if (s.length + next.length > budget) { s += ` (+${items.length - i} more)`; break; }
    s += next;
  }
  return s + '.';
}

// facts: { apps:[{name,desc}], skills:[id], companions:[name], routines:[name], failures:[fingerprint], source }
function buildProfile(facts = {}, config = {}) {
  const kw = Object.entries(config.keywords || {}).filter(([, w]) => w >= 2).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const parts = [
    'Agentic HQ: a local-first personal agent homepage + "Second Brain" for one developer on Windows 11. Zero-dependency Node server (server.js on localhost) with lib/*.cjs helpers and tools/*.mjs CLIs; node --test suite; local git only.',
    'It launches and supervises coding-agent workers through a skills deck and Orca worktree orchestration, runs scheduled routines (Windows Task Scheduler + Claude Code scheduled tasks), meters each agent\'s usage limits, keeps an event inbox, an attention budget for ntfy phone pushes, and a ring of HTML report artifacts.',
    joinCapped('Worker lanes', WORKER_LANES, 140),
    joinCapped('Companions', (facts.companions || []).map(c => clean(c, 30)), 160),
    joinCapped('Micro apps', (facts.apps || []).map(a => clean(a.name || a, 30)), 200),
    joinCapped('Deck cards', (facts.skills || []).map(s => clean(s, 30)), 220),
    joinCapped('Routines', (facts.routines || []).map(r => clean(r, 34)), 220),
    joinCapped('Open problems', (facts.failures || []).map(f => clean(f, 48)), 220),
    joinCapped('Wants better', kw.slice(0, 18), 260)
  ].filter(Boolean);
  let digest = '';
  for (const p of parts) { if ((digest + ' ' + p).trim().length > MAX_DIGEST) break; digest = (digest + ' ' + p).trim(); }
  digest = redact(digest).slice(0, MAX_DIGEST);
  const keywords = { ...(config.keywords || {}) };
  for (const c of facts.companions || []) { const k = String(c).toLowerCase(); if (k.length > 2 && !(k in keywords)) keywords[k] = 2; }
  return { digest, keywords };
}

async function getJson(url, fetchImpl, ms = 6000) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const COMPANION_NAMES = { basicMemory: 'Basic Memory', qmd: 'QMD', cass: 'CASS session search', karakeep: 'Karakeep', changedetection: 'changedetection.io', ntfy: 'ntfy', promptfoo: 'promptfoo' };

async function gatherFacts(opts = {}) {
  const hqUrl = String(opts.hqUrl || 'http://localhost:50000').replace(/\/+$/, '');
  const kit = opts.kit || KIT, fetchImpl = opts.fetchImpl || globalThis.fetch;
  const facts = { apps: [], skills: [], companions: [], routines: [], failures: [], source: 'live' };
  try {
    const [apps, skills, health, routines] = await Promise.all([
      getJson(hqUrl + '/api/apps', fetchImpl), getJson(hqUrl + '/api/skills', fetchImpl),
      getJson(hqUrl + '/api/health', fetchImpl), getJson(hqUrl + '/api/routines', fetchImpl).catch(() => ({ routines: [] }))
    ]);
    facts.apps = (apps.apps || []).map(a => ({ name: a.name, desc: a.desc }));
    facts.skills = (skills.skills || []).map(s => s.id);
    facts.companions = Object.keys(health.companions || {}).map(k => COMPANION_NAMES[k] || k);
    facts.routines = (routines.routines || []).map(r => r.n || r.name).filter(Boolean);
  } catch (_) {
    facts.source = 'os-config.json';
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(kit, 'os-config.json'), 'utf8').replace(/^\uFEFF/, ''));
      facts.apps = (cfg.microApps || []).map(a => ({ name: a.name, desc: a.desc }));
      facts.skills = (cfg.skills || []).map(s => s.id);
      facts.companions = Object.values(COMPANION_NAMES);
    } catch (_) { /* nothing to add */ }
  }
  try { facts.failures = parseFailureRegistry(fs.readFileSync(opts.registry || REGISTRY, 'utf8')); } catch (_) { }
  return facts;
}

module.exports = { redact, parseFailureRegistry, buildProfile, gatherFacts, MAX_DIGEST };
