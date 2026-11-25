#!/usr/bin/env node
// Read-only deterministic regression evaluation for HQ context retrieval.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { buildContextPack } = createRequire(import.meta.url)('../lib/context-pack.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(here, '..', 'config', 'hq-context-eval.json');
const base = `http://127.0.0.1:${Number(process.env.HQ_PORT || process.env.PORT) || 50000}`;
const direct = process.argv.includes('--direct');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!Array.isArray(config.cases) || config.cases.length < 10) throw new Error('Eval config must contain at least 10 cases');
const cases = config.cases;

function pattern(value) {
  try { return new RegExp(value, 'i'); }
  catch (error) { throw new Error(`Invalid source pattern ${JSON.stringify(value)}: ${error.message}`); }
}

function evaluate(item, pack, endpointOk) {
  const sources = Array.isArray(pack.sources) ? pack.sources : [];
  const authorities = Array.isArray(pack.authorities) ? pack.authorities : [];
  const topicIds = new Set(authorities.map(x => x.id));
  const requiredTopics = item.requiredTopics || [];
  const requiredSources = (item.requiredSources || []).map(pattern);
  const forbiddenSources = (item.forbiddenSources || []).map(pattern);
  const topics = requiredTopics.every(id => topicIds.has(id));
  const source = requiredSources.every(re => sources.some(x => re.test(String(x.path || ''))));
  const forbidden = forbiddenSources.every(re => sources.every(x => !re.test(String(x.path || ''))));
  const cited = sources.every(x => x.path && x.lineStart > 0 && x.sha256);
  const matched = authorities.length > 0;
  const match = matched === Boolean(item.shouldMatch);
  const canonicalPositions = sources.map((x, index) => x.canonical ? index : -1).filter(index => index >= 0);
  const nonCanonicalPositions = sources.map((x, index) => !x.canonical ? index : -1).filter(index => index >= 0);
  const canonicalFirst = !item.canonicalFirst || canonicalPositions.length > 0 &&
    (!nonCanonicalPositions.length || Math.max(...canonicalPositions) < Math.min(...nonCanonicalPositions));
  let freshness = true;
  if (item.freshness) {
    const expected = item.freshness;
    const found = sources.find(x => pattern(expected.source).test(String(x.path || '')));
    freshness = Boolean(found?.observedAt && found?.freshness) &&
      (!expected.basis || found.freshness.basis === expected.basis) &&
      (!expected.verdict || found.freshness.verdict === expected.verdict) &&
      (expected.maxAgeDays == null || Number(found.freshness.ageDays) <= expected.maxAgeDays);
  }
  const budget = item.maxTokens == null || Boolean(pack.budget) &&
    pack.budget.maxTokens === item.maxTokens && pack.budget.estimatedTokens <= item.maxTokens &&
    (!item.shouldDropSource || pack.budget.droppedSources?.length > 0);
  const checks = { endpoint: endpointOk, match, topics, source, forbidden, cited, canonicalFirst, freshness, budget };
  return {
    id: item.id,
    task: item.task,
    passed: Object.values(checks).every(Boolean),
    ...checks,
    topic: topics,
    matched,
    sourceCount: pack.sourceCount,
    budgetReport: pack.budget || null
  };
}

const rows = [];
for (const item of cases) {
  try {
    let pack, ok = true;
    const options = { task: item.task, brainPort: Number(process.env.BRAIN_PORT) || 50201 };
    if (item.maxTokens != null) options.maxTokens = item.maxTokens;
    if (direct) pack = await buildContextPack(options);
    else {
      const token = process.env.HQ_TOKEN || process.env.RUBRIC_TOKEN, headers = token ? { 'x-rubric-token': token } : {};
      const response = await fetch(`${base}/api/context?q=${encodeURIComponent(item.task)}`, { headers, signal: AbortSignal.timeout(60000) });
      const livePack = await response.json(); ok = response.ok;
      // The public endpoint intentionally uses the configured production budget. Exercise it
      // for liveness, then compile the same packet locally only for a case-specific tight budget.
      pack = item.maxTokens == null ? livePack : await buildContextPack(options);
    }
    rows.push(evaluate(item, pack, ok));
  } catch (error) { rows.push({ id: item.id, task: item.task, passed: false, error: error.message }); }
}
const passed = rows.filter(x => x.passed).length;
console.log(JSON.stringify({ passed, total: rows.length, mode: direct ? 'direct' : 'live', config: configPath, cases: rows }, null, 2));
if (passed !== rows.length) process.exitCode = 1;
