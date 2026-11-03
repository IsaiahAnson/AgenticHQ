'use strict';
const fs = require('fs');
const path = require('path');
// AI Radar triage and contract checks (deterministic, no network).
//   scoreItem(item, { keywords, config, now }) -> { total 0-100, parts, multiplier, flags }
//     total = relevance 30 + maintenance 25 + substance 15 + momentum 15 + agreement 10 + license 5 (weights in config/radar.json),
//     times a liveness multiplier (x0.35 no commit in 90 days, x0.6 no release in 6 months when the repo ships releases).
//   extractJson(text), validateReasoned(raw, ctx), validateRun(run), sortFindings(list)

const OSI = new Set(['MIT', 'APACHE-2.0', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'ISC', 'MPL-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0',
  'AGPL-3.0', 'UNLICENSE', '0BSD', 'EPL-2.0', 'ZLIB', 'BSL-1.0', 'ARTISTIC-2.0', 'CC0-1.0', 'GPL-2.0-ONLY', 'GPL-3.0-ONLY', 'AGPL-3.0-ONLY', 'LGPL-3.0-ONLY']);
const DEFAULT_WEIGHTS = { relevance: 30, maintenance: 25, substance: 15, momentum: 15, agreement: 10, license: 5 };
const VERDICTS = ['adopt', 'trial', 'watch', 'skip'];
const CONFIDENCE = ['high', 'medium', 'low'];
const EFFORTS = ['S', 'M', 'L'];
const RISK_KINDS = ['supply-chain', 'privacy', 'secrets', 'stability', 'lock-in'];
const REASONERS = ['claude', 'codex', 'deepseek', 'none'];

const days = (now, iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? (now - t) / 864e5 : null; };
const clamp01 = x => Math.max(0, Math.min(1, x));
const logScale = (v, top) => clamp01(Math.log10(1 + Math.max(0, v)) / Math.log10(1 + top));
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };

function textOf(item) {
  return [item.title, item.text, (item.signals.topics || []).join(' '), item.readme || '', item.releaseNotes || ''].join(' \n ').toLowerCase();
}
function hits(text, term) {
  const esc = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s_-]?');
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text);
}

// Title, description and topics count fully; README/release-notes matches count half and only for weighted terms (>= 2),
// so a long README full of generic words cannot max out relevance.
function relevance(item, keywords, bonusTerms) {
  const head = [item.title, item.text, (item.signals.topics || []).join(' ')].join(' ').toLowerCase();
  const body = [item.readme || '', item.releaseNotes || ''].join(' \n ').toLowerCase();
  let h = 0, b = 0;
  for (const [k, w] of Object.entries(keywords || {})) {
    if (!w) continue;
    if (hits(head, k)) h += w; else if (w >= 2 && hits(body, k)) b += w * 0.5;
  }
  const bonus = (bonusTerms || []).filter(t => hits(head, t) || hits(item.readme || '', t)).length;
  const v = clamp01((h + Math.min(b, 8)) / 16) * 0.85 + clamp01(bonus / 3) * 0.15;
  return v;
}

function maintenance(item, cfg) {
  const s = item.signals;
  if (!s.enriched) {
    const trusted = (cfg.trustedPublishers || []).some(h => hostOf(item.url).endsWith(h) || item.sources.some(x => hostOf(x.url).endsWith(h)));
    return trusted ? 0.6 : 0.32;
  }
  const c30 = s.commits30 || 0;
  const commits = c30 >= 20 ? 1 : c30 >= 5 ? 0.7 : c30 >= 1 ? 0.4 : 0;
  const relAge = days(cfg.now, s.lastReleaseAt);
  const release = relAge !== null && relAge <= 60 ? 1 : (s.releases ? 0.3 : (c30 >= 5 ? 0.5 : 0.2));
  const people = (s.contributors90 || 0) >= 3 ? 1 : s.contributors90 === 2 ? 0.5 : s.contributors90 === 1 ? 0.2 : 0;
  const issuesTotal = (s.openIssues || 0) + (s.closedIssues || 0);
  const issues = issuesTotal ? clamp01((s.closedIssues || 0) / issuesTotal / 0.6) : 0.5;
  return commits * 0.4 + release * 0.24 + people * 0.24 + issues * 0.12;
}

function substance(item) {
  const s = item.signals;
  if (!s.enriched) {
    if (item.kind === 'release') return 0.65;
    return (item.text || '').length > 200 ? 0.55 : 0.35;
  }
  if (!s.diskKB) return 0;
  let v = s.diskKB < 50 ? 0.2 : s.diskKB < 500 ? 0.55 : 0.8;
  if (s.readmeBytes && (s.diskKB * 1024) / s.readmeBytes < 3) v -= 0.3;   /* README is most of the repo */
  if (s.releases) v += 0.1;
  if ((s.topics || []).length) v += 0.1;
  if (s.fork) v -= 0.2;
  return clamp01(v);
}

function momentum(item) {
  const s = item.signals;
  const parts = [
    logScale(s.starsPerDay || 0, 200),
    logScale(s.hnPoints || 0, 500),
    logScale(s.lobstersScore || 0, 80),
    s.redditRank ? clamp01((11 - s.redditRank) / 12) : 0
  ];
  let v = Math.max(...parts);
  const hype = s.enriched && (s.stars || 0) >= 1000 && (s.commits30 || 0) < 3;
  if (hype) v *= 0.5;
  if (s.enriched && (s.starsPerDay || 0) > 100 && (s.contributors90 || 0) <= 1) v *= 0.7;
  return { v, hype };
}

function agreement(item) {
  const n = item.signals.sourceCount || new Set(item.sources.map(s => s.id)).size;
  return n >= 3 ? 1 : n === 2 ? 0.7 : 0.3;
}

function license(item) {
  const s = item.signals;
  if (!s.enriched) return { v: 0.5, flag: 'unknown' };
  const id = String(s.license || '').toUpperCase();
  if (!id) return { v: 0, flag: 'none' };
  if (OSI.has(id)) return { v: 1, flag: null };
  return { v: 0.4, flag: id === 'NOASSERTION' || id === 'OTHER' ? 'unknown' : 'non-osi' };
}

function liveness(item, cfg) {
  const s = item.signals, l = cfg.liveness || {};
  if (!s.enriched) return 1;
  if (s.archived) return l.noCommitFactor || 0.35;
  const commitAge = days(cfg.now, s.lastCommitAt || s.pushedAt);
  if (commitAge !== null && commitAge > (l.noCommitDays || 90)) return l.noCommitFactor || 0.35;
  const relAge = days(cfg.now, s.lastReleaseAt);
  if (s.releases && relAge !== null && relAge > (l.noReleaseDays || 180)) return l.noReleaseFactor || 0.6;
  return 1;
}

function scoreItem(item, { keywords, config = {}, now = Date.now() } = {}) {
  const cfg = { ...config, now };
  const w = { ...DEFAULT_WEIGHTS, ...(config.weights || {}) };
  const m = momentum(item), lic = license(item);
  const raw = {
    relevance: relevance(item, keywords || config.keywords, config.bonusTerms),
    maintenance: maintenance(item, cfg), substance: substance(item), momentum: m.v, agreement: agreement(item), license: lic.v
  };
  const parts = {};
  for (const k of Object.keys(DEFAULT_WEIGHTS)) parts[k] = Math.round(raw[k] * w[k] * 10) / 10;
  if (item.signals.watchlist) parts.relevance = Math.min(w.relevance, Math.round((parts.relevance + 10) * 10) / 10);
  const multiplier = liveness(item, cfg);
  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  const flags = [];
  if (m.hype) flags.push('hype');
  if (lic.flag) flags.push('license-' + lic.flag);
  if (multiplier < 1) flags.push('liveness-x' + multiplier);
  return { total: Math.round(Math.min(100, sum * multiplier)), parts, multiplier, flags };
}

function watchGate(item, cfg = {}) {
  if (!item?.signals?.watchlist) return { review: true, note: '', reason: 'not-watched' };
  const tag = String(item.signals.releaseTag || item.tag || '');
  const lowerTag = tag.toLowerCase();
  const ignored = (cfg.watchIgnoreTags || []).find(term => lowerTag.includes(String(term).toLowerCase()));
  if (ignored) return { review: false, note: `ignored: ${tag || ignored}`, reason: 'ignored-tag' };
  const text = [item.title, item.text, item.releaseNotes].join(' ').toLowerCase();
  const dependency = (cfg.watchDepends || []).find(term => hits(text, String(term)));
  if (dependency) return { review: true, note: `review: ${dependency}`, reason: 'dependency' };
  const parse = value => { const m = String(value || '').match(/(?:^|[^0-9])(\d+)\.(\d+)(?:\.|$)/); return m ? [Number(m[1]), Number(m[2])] : null; };
  const current = parse(tag), previous = parse(item.seen?.lastVersion || item.lastVersion || item.signals.lastSeenVersion);
  if (current && previous && (current[0] > previous[0] || (current[0] === previous[0] && current[1] > previous[1])))
    return { review: true, note: `review: ${previous.join('.')} → ${current.join('.')}`, reason: 'version-bump' };
  const first = String(item.releaseNotes || item.text || item.title || '').split(/\r?\n/).map(x => x.replace(/^\s*[-*#]+\s*/, '').trim()).find(Boolean) || 'release noted';
  return { review: false, note: first.slice(0, 180), reason: 'digest' };
}

// ---------- JSON from model output ----------
function extractJson(text) {
  const src = String(text || '').trim();
  const tries = [src];
  for (const m of src.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) tries.push(m[1]);
  const a = src.indexOf('['), b = src.lastIndexOf(']'), c = src.indexOf('{'), d = src.lastIndexOf('}');
  if (c >= 0 && d > c) tries.push(src.slice(c, d + 1));
  if (a >= 0 && b > a) tries.push(src.slice(a, b + 1));
  for (const t of tries) { try { return JSON.parse(t); } catch (_) { } }
  throw new Error('no parseable JSON in model output');
}

const str = v => typeof v === 'string' && v.trim().length > 0;
const strArr = v => Array.isArray(v) && v.every(x => typeof x === 'string');

// Validate the reasoning model's findings. ctx: { keys:Set, fileExists(path)->bool, maxConfidence }
// Returns { findings: Map(key -> cleaned), errors: [string] }.
function validateReasoned(raw, ctx = {}) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.findings) ? raw.findings : null);
  const errors = [], findings = new Map();
  if (!list) return { findings, errors: ['output must be a JSON array of findings (or {"findings": [...]})'] };
  for (const [i, f] of list.entries()) {
    const at = `findings[${i}]${f && f.key ? ' ' + f.key : ''}`;
    const errs = [];
    if (!f || typeof f !== 'object') { errors.push(`${at}: not an object`); continue; }
    if (!str(f.key) || (ctx.keys && !ctx.keys.has(f.key))) errs.push('key must be one of the given item keys');
    if (!VERDICTS.includes(f.verdict)) errs.push(`verdict must be one of ${VERDICTS.join('|')}`);
    if (!CONFIDENCE.includes(f.confidence)) errs.push(`confidence must be one of ${CONFIDENCE.join('|')}`);
    if (!str(f.summary)) errs.push('summary is required');
    if (typeof f.whatsNew !== 'string') errs.push('whatsNew must be a string');
    const r = f.reasoning;
    if (!r || typeof r !== 'object') errs.push('reasoning object is required');
    else {
      if (!Array.isArray(r.fit) || !r.fit.length || !r.fit.every(x => x && str(x.area) && strArr(x.files) && str(x.why))) errs.push('reasoning.fit must be a non-empty array of {area, files[], why}');
      for (const k of ['benefit', 'cost', 'counter', 'overlap', 'maintenance', 'license', 'dependencies', 'falsify']) if (!str(r[k])) errs.push(`reasoning.${k} is required`);
      if (!EFFORTS.includes(r.effort)) errs.push('reasoning.effort must be S|M|L');
      if (!Array.isArray(r.risks) || !r.risks.every(x => x && RISK_KINDS.includes(x.kind) && str(x.detail))) errs.push(`reasoning.risks must be [{kind: ${RISK_KINDS.join('|')}, detail}]`);
      if (!Array.isArray(r.evidence) || !r.evidence.length || !r.evidence.every(x => x && str(x.claim) && typeof x.checked === 'boolean' && str(x.how)
        && (!str(x.quote) || x.quote.trim().length <= 160)
        && (x.kind !== 'falsify' || typeof x.holds === 'boolean'))) errs.push('reasoning.evidence must include {claim, checked:boolean, how}; quotes must be at most 160 characters and falsify entries need holds:boolean');
      if (!strArr(r.steps) || r.steps.length < 2) errs.push('reasoning.steps must be at least 2 strings');
      if (Array.isArray(r.fit) && ctx.fileExists) {
        const missing = r.fit.flatMap(x => (x && Array.isArray(x.files) ? x.files : [])).filter(p => typeof p === 'string' && !/^new:/i.test(p) && !ctx.fileExists(p));
        if (missing.length) errs.push(`reasoning.fit files not found in the repo (prefix new files with "new:"): ${missing.slice(0, 6).join(', ')}`);
      }
    }
    const needPlan = f.verdict === 'adopt' || f.verdict === 'trial';
    if (!strArr(f.plan) || f.plan.length > 6 || (needPlan && f.plan.length < 3)) errs.push('plan must be 3-6 strings for adopt/trial (0-6 otherwise)');
    if (errs.length) { errors.push(`${at}: ${errs.join('; ')}`); continue; }
    let confidence = f.confidence;
    let verdict = f.verdict;
    const flags = Array.isArray(f.flags) ? [...f.flags] : [];
    const falsify = r.evidence.find(x => x.kind === 'falsify');
    if (falsify?.holds === true) { verdict = 'watch'; if (!flags.includes('falsified')) flags.push('falsified'); }
    if ((verdict === 'trial' || verdict === 'adopt') && !falsify) {
      confidence = 'low';
      if (!flags.includes('falsify-unchecked')) flags.push('falsify-unchecked');
    }
    if (ctx.maxConfidence && CONFIDENCE.indexOf(confidence) < CONFIDENCE.indexOf(ctx.maxConfidence)) confidence = ctx.maxConfidence;
    findings.set(f.key, {
      verdict, confidence, flags, summary: f.summary.trim(), whatsNew: f.whatsNew.trim(),
      reasoning: {
        fit: r.fit.map(x => ({ area: x.area, files: x.files, why: x.why })), benefit: r.benefit, cost: r.cost, effort: r.effort,
        risks: r.risks.map(x => ({ kind: x.kind, detail: x.detail })), counter: r.counter, overlap: r.overlap,
        evidence: r.evidence.map(x => ({ claim: x.claim, checked: x.checked, how: x.how, ...(str(x.quote) ? { quote: x.quote.trim() } : {}),
          ...(x.kind ? { kind: x.kind } : {}), ...(typeof x.holds === 'boolean' ? { holds: x.holds } : {}) })), steps: r.steps,
        maintenance: r.maintenance, license: r.license, dependencies: r.dependencies, falsify: r.falsify
      },
      plan: f.plan, pinnedClaim: str(f.pinned) ? f.pinned : ''
    });
  }
  return { findings, errors };
}

const collapsed = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
function verifyQuotes(finding, sources = {}) {
  const texts = Array.isArray(sources) ? sources : (sources.texts || []);
  const haystacks = texts.map(collapsed).filter(Boolean);
  const kit = !Array.isArray(sources) && sources.kit ? path.resolve(sources.kit) : null;
  const evidence = finding?.reasoning?.evidence || [];
  let checked = 0, unverified = 0;
  for (const entry of evidence) {
    if (!entry.checked && !entry.unverified) continue;
    checked++;
    const how = String(entry.how || '');
    if (kit) for (const match of how.matchAll(/(?:^|\s)([\w.-]+(?:[\\/][\w .()@+-]+)+)/g)) {
      const rel = match[1].replace(/\\/g, '/').replace(/[),.;:]+$/, '');
      const file = path.resolve(kit, rel);
      if ((file === kit || file.startsWith(kit + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        try { haystacks.push(collapsed(fs.readFileSync(file, 'utf8'))); } catch (_) { }
      }
    }
    const quote = collapsed(entry.quote);
    const found = quote.length >= 8 && haystacks.some(text => text.includes(quote));
    if (!found) { entry.checked = false; entry.unverified = true; unverified++; }
    else { entry.checked = true; delete entry.unverified; }
  }
  if (checked && unverified > checked / 2) {
    finding.confidence = 'low';
    finding.flags = Array.isArray(finding.flags) ? finding.flags : [];
    if (!finding.flags.includes('unverified-evidence')) finding.flags.push('unverified-evidence');
  }
  return finding;
}

// Drop fit files that do not exist (after the repair retry failed only on that).
function dropMissingFiles(raw, fileExists) {
  const list = Array.isArray(raw) ? raw : (raw && raw.findings) || [];
  for (const f of list) for (const x of (f && f.reasoning && Array.isArray(f.reasoning.fit) ? f.reasoning.fit : [])) {
    if (Array.isArray(x.files)) x.files = x.files.filter(p => typeof p === 'string' && (/^new:/i.test(p) || fileExists(p)));
  }
  return raw;
}

function sortFindings(list) {
  return [...list].sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || (b.score.total - a.score.total));
}

// Whole-run contract check (common spec + decisions.md fields). Returns a list of problems; empty = valid.
function validateRun(run) {
  const p = [];
  const need = (cond, msg) => { if (!cond) p.push(msg); };
  need(run && /^\d{8}-\d{4}$/.test(run.runId), 'runId must be YYYYMMDD-HHMM');
  if (!run) return p;
  need(str(run.startedAt) && str(run.finishedAt), 'startedAt/finishedAt required');
  need(['ok', 'partial', 'failed'].includes(run.status), 'status must be ok|partial|failed');
  need(run.lanes && run.lanes.collect && run.lanes.deepseek && run.lanes.reason, 'lanes.collect/deepseek/reason required');
  need(run.lanes && run.lanes.reason && REASONERS.includes(run.lanes.reason.agent), 'lanes.reason.agent invalid');
  need(Array.isArray(run.sources) && run.sources.every(s => str(s.id) && typeof s.ok === 'boolean' && Number.isFinite(s.items) && Number.isFinite(s.ms)), 'sources[] shape');
  need(run.counts && ['collected', 'new', 'triaged', 'reasoned'].every(k => Number.isFinite(run.counts[k])), 'counts shape');
  need(typeof run.profileDigest === 'string' && run.profileDigest.length <= 1500, 'profileDigest <= 1500 chars');
  need(Array.isArray(run.findings) && run.findings.length <= 12, 'findings: array of at most 12');
  const ids = new Set();
  for (const f of run.findings || []) {
    const at = `finding ${f && f.id}`;
    need(f && /^[a-z0-9][a-z0-9-]{0,80}$/.test(f.id) && !ids.has(f.id), `${at}: id invalid or duplicate`); ids.add(f && f.id);
    if (!f) continue;
    need(str(f.key) && /^(gh|url|pkg):/.test(f.key), `${at}: key`);
    need(str(f.title) && str(f.url), `${at}: title/url`);
    need(['repo', 'release', 'tool', 'technique', 'model', 'article'].includes(f.kind), `${at}: kind`);
    need(Array.isArray(f.sources) && f.sources.length > 0, `${at}: sources`);
    need(f.signals && Number.isFinite(f.signals.sourceCount), `${at}: signals.sourceCount`);
    need(f.score && Number.isFinite(f.score.total) && f.score.total >= 0 && f.score.total <= 100 && f.score.parts, `${at}: score`);
    need(VERDICTS.includes(f.verdict) && CONFIDENCE.includes(f.confidence), `${at}: verdict/confidence`);
    need(typeof f.summary === 'string' && typeof f.whatsNew === 'string', `${at}: summary/whatsNew`);
    need(REASONERS.includes(f.reasonedBy), `${at}: reasonedBy`);
    need(typeof f.pinned === 'string', `${at}: pinned`);
    const r = f.reasoning;
    need(r && Array.isArray(r.fit) && Array.isArray(r.risks) && Array.isArray(r.evidence) && Array.isArray(r.steps), `${at}: reasoning arrays`);
    if (r) for (const k of ['benefit', 'cost', 'counter', 'overlap', 'maintenance', 'license', 'dependencies', 'falsify']) need(typeof r[k] === 'string', `${at}: reasoning.${k}`);
    need(r && (r.effort === '' || EFFORTS.includes(r.effort)), `${at}: reasoning.effort`);
    need(Array.isArray(f.plan) && f.plan.length <= 6, `${at}: plan`);
  }
  const order = (run.findings || []).map(f => VERDICTS.indexOf(f.verdict) * 1000 - (f.score ? f.score.total : 0));
  need(order.every((v, i) => i === 0 || order[i - 1] <= v), 'findings must be sorted by verdict then score');
  return p;
}

module.exports = { scoreItem, watchGate, verifyQuotes, extractJson, validateReasoned, dropMissingFiles, validateRun, sortFindings, VERDICTS, CONFIDENCE, RISK_KINDS, DEFAULT_WEIGHTS };
