'use strict';

const { keyFor } = require('./radar-sources.cjs');

const collapse = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

function projectKey(value) {
  if (value && typeof value === 'object') value = value.key || value.url;
  const raw = String(value || '').trim();
  if (/^(gh|pkg|url):/.test(raw)) return raw.replace(/(?:\/releases?\/tag\/[^/?#]+|\/releases?\/[^/?#]+)$/i, '');
  return keyFor(raw) || raw;
}

function findingText(finding) {
  const r = finding?.reasoning || {};
  return collapse([finding?.title, finding?.summary, finding?.whatsNew, finding?.url, finding?.text,
    finding?.readme, finding?.releaseNotes, r.benefit, r.counter].join(' '));
}

function labels(decisions = {}, runs = []) {
  const out = [];
  const findings = new Map();
  for (const run of runs || []) for (const finding of run?.findings || []) {
    findings.set(`${run.runId}:${finding.id}`, finding);
    if (!findings.has(finding.id)) findings.set(finding.id, finding);
  }
  const items = decisions?.items && typeof decisions.items === 'object' ? decisions.items : decisions;
  for (const [id, decision] of Object.entries(items || {})) {
    if (!decision || typeof decision !== 'object') continue;
    const finding = findings.get(`${decision.runId}:${id}`) || findings.get(id) || {};
    const key = projectKey(decision.key || finding.key || finding.url);
    if (!key) continue;
    const base = { projectKey: key, at: decision.at || '', version: decision.version || finding.signals?.releaseTag || finding.pinned || '',
      text: findingText(finding) || collapse([decision.title, decision.note].join(' ')) };
    if (decision.decision === 'implement') out.push({ ...base, value: 1, kind: 'implement' });
    if (decision.merged) out.push({ ...base, value: 2, kind: 'merged' });
    if (decision.decision === 'dismiss') out.push({ ...base, value: -1, kind: 'dismiss' });
    if (decision.decision === 'later') out.push({ ...base, value: -0.5, kind: 'later' });
  }
  for (const regret of decisions?.regrets || []) {
    const key = projectKey(regret.key || regret.url);
    if (key) out.push({ projectKey: key, at: regret.at || '', version: '', value: 1, kind: 'regret', text: collapse(`${regret.url || ''} ${regret.note || ''}`) });
  }
  return out;
}

function wilson(positive, total, z = 1.28) {
  if (!(total > 0)) return null;
  const p = positive / total;
  const zz = z * z;
  return Math.max(0, (p + zz / (2 * total) - z * Math.sqrt((p * (1 - p) + zz / (4 * total)) / total)) / (1 + zz / total));
}

function versionPair(value) {
  const m = String(value || '').match(/(?:^|[^0-9])(\d+)\.(\d+)(?:\.|$)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function newerMinor(current, dismissed) {
  const a = versionPair(current), b = versionPair(dismissed);
  return !!(a && b && (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])));
}

function priors(allLabels = [], keywords = {}) {
  const weightedTerms = Object.entries(keywords || {}).filter(([, weight]) => Number(weight) >= 2).map(([term]) => term);
  const groups = new Map(), dismissed = new Map();
  const add = (key, label) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(label);
  };
  for (const label of allLabels || []) {
    if (!label || !Number.isFinite(label.value)) continue;
    add(`project:${label.projectKey}`, label);
    for (const term of weightedTerms) if (collapse(label.text).includes(term.toLowerCase())) add(`topic:${term}`, label);
    if (label.kind === 'dismiss') {
      const old = dismissed.get(label.projectKey);
      if (!old || String(label.at || '') > String(old.at || '')) dismissed.set(label.projectKey, label);
    }
  }
  const bounds = new Map();
  for (const [key, list] of groups) {
    const positive = list.reduce((n, x) => n + Math.max(0, x.value) * 2, 0);
    const total = list.reduce((n, x) => n + Math.abs(x.value) * 2, 0);
    bounds.set(key, wilson(positive, total));
  }
  function multiplier(item) {
    const key = projectKey(item);
    const dismissal = dismissed.get(key);
    const tag = item?.signals?.releaseTag || item?.tag || item?.pinned || '';
    if (dismissal && !newerMinor(tag, dismissal.version)) return { multiplier: 0, flags: ['dismissed-before'], projectKey: key, wilson: 0 };
    const text = findingText(item);
    const values = [];
    if (bounds.has(`project:${key}`)) values.push(bounds.get(`project:${key}`));
    for (const term of weightedTerms) if (text.includes(term.toLowerCase()) && bounds.has(`topic:${term}`)) values.push(bounds.get(`topic:${term}`));
    if (!values.length) return { multiplier: 1, flags: [], projectKey: key, wilson: null };
    const bound = values.reduce((a, b) => a + b, 0) / values.length;
    return { multiplier: Math.max(0.6, Math.min(1.4, 0.6 + 0.8 * bound)), flags: [], projectKey: key, wilson: bound };
  }
  return { multiplier, bounds, dismissed };
}

function priorVerdict(key, runs = []) {
  const wanted = projectKey(key);
  let best = null;
  for (const run of runs || []) for (const finding of run?.findings || []) {
    if (projectKey(finding) !== wanted) continue;
    const candidate = { runId: run.runId, verdict: finding.verdict, summary: finding.summary || '', counter: finding.reasoning?.counter || '' };
    if (!best || String(candidate.runId) > String(best.runId)) best = candidate;
  }
  return best;
}

module.exports = { labels, priors, priorVerdict, projectKey, wilson, versionPair, newerMinor };
