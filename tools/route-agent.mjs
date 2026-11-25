#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILES_PATH = path.join(ROOT, 'config', 'agent-profiles.json');
const HQ_URL = 'http://127.0.0.1:50000';
const HIGH_USAGE = 90;

function parseArgs(argv) {
  let json = false;
  const taskParts = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') return { help: true, json, task: '' };
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else taskParts.push(arg);
  }
  const task = taskParts.join(' ').trim();
  if (!task) throw new Error('Usage: node tools/route-agent.mjs "<task>" [--json]');
  return { help: false, json, task };
}

function classifyTask(task) {
  const text = task.toLowerCase();
  const local = /(?:\blocal\b|\bprivate\b|\bworkspace\b|\brepositor(?:y|ies)\b|\brepo\b|\bcodebase\b|\bedit\b|\bimplement\b|\bfix\b|\bdebug\b|\brefactor\b|\bfile\b|[a-z]:[\\/])/.test(text);
  const code = /\b(code|coding|implement|implementation|edit|fix|debug|refactor|test|repository|repo|codebase|script|function|api)\b/.test(text);
  const research = /\b(research|web|internet|public sources?|source comparison|literature|find sources?|browse|citations?|evidence)\b/.test(text);
  const verification = /\b(verify|verification|audit|review|test|fact.check|validate)\b/.test(text);
  return {
    taskType: code ? 'code' : research ? 'research' : verification ? 'verification' : 'general',
    dataBoundary: local ? 'local-workspace' : research ? 'public' : 'unspecified',
    traits: { code, research, verification, local }
  };
}

async function fetchJson(endpoint) {
  const headers = {};
  const token = process.env.HQ_TOKEN || process.env.RUBRIC_TOKEN;
  if (token) headers['x-rubric-token'] = token;
  try {
    const response = await fetch(`${HQ_URL}${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(2500)
    });
    if (!response.ok) return { reachable: false, status: response.status, data: null };
    return { reachable: true, status: response.status, data: await response.json() };
  } catch (error) {
    return { reachable: false, status: null, data: null, error: error.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

function usageByAgent(stats) {
  const result = new Map();
  for (const meter of stats?.meters || []) {
    const preferredLabel = meter.id === 'copilot' ? 'credits' : '5h';
    const window = (meter.windows || []).find(item => item.label === preferredLabel) || meter.windows?.[0];
    if (window && Number.isFinite(Number(window.used))) {
      result.set(String(meter.id).toLowerCase(), { used: Number(window.used), window: window.label });
    }
  }
  return result;
}

function outcomeRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ['outcomes', 'items', 'results', 'rows']) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function comparableOutcomes(payload, taskType) {
  const result = new Map();
  for (const row of outcomeRows(payload)) {
    const agent = String(row?.agent || '').toLowerCase();
    const rowType = String(row?.taskType || '').toLowerCase();
    if (!agent || !rowType || (rowType !== taskType && rowType !== 'general')) continue;
    const status = String(row?.status || '').toLowerCase();
    const settled = /^(succeeded|success|completed|failed|failure|error)$/.test(status);
    if (!settled) continue;
    const current = result.get(agent) || { total: 0, succeeded: 0 };
    current.total += 1;
    if (/^(succeeded|success|completed)$/.test(status)) current.succeeded += 1;
    result.set(agent, current);
  }
  return result;
}

function baseScore(profile, classification) {
  const { code, research, verification } = classification.traits;
  if (profile.id === 'deepseek') return research ? 92 : 20;
  if (profile.id === 'codex') return code ? 88 : verification ? 82 : research ? 70 : 78;
  if (profile.id === 'claude') return code ? 86 : verification ? 84 : research ? 76 : 80;
  if (profile.id === 'copilot') return code ? 72 : research ? 58 : 62;
  if (profile.id === 'kilocode') return code ? 68 : 45;
  return 50;
}

function rankProfiles(profiles, classification, usage, outcomes) {
  const suggestions = [];
  const ineligible = [];
  for (const profile of profiles) {
    if (profile.id === 'deepseek' && classification.dataBoundary !== 'public') {
      ineligible.push({
        agent: profile.id,
        name: profile.name,
        reasons: ['Public-only privacy boundary does not permit this task.']
      });
      continue;
    }

    let score = baseScore(profile, classification);
    const reasons = [];
    if (profile.id === 'deepseek') reasons.push('Strong fit for bounded public research and source comparison.');
    else if (classification.traits.code && ['codex', 'claude'].includes(profile.id)) reasons.push('Strong fit for local implementation and verification.');
    else if (classification.traits.code) reasons.push('Profile supports scoped local code work.');
    else if (classification.traits.research) reasons.push('Can support research, synthesis, or verification.');
    else reasons.push('General task fit based on the static profile.');

    const meter = usage.get(profile.id);
    if (meter) {
      if (meter.used >= HIGH_USAGE) {
        score -= 55;
        reasons.push(`Demoted: ${meter.used}% of the ${meter.window} allowance is used (threshold ${HIGH_USAGE}%).`);
      } else {
        reasons.push(`Usage is below the demotion threshold (${meter.used}% of ${meter.window}).`);
      }
    } else {
      reasons.push('No matching live usage meter was available.');
    }

    const history = outcomes.get(profile.id);
    if (history?.total) {
      const rate = history.succeeded / history.total;
      score += Math.round((rate - 0.5) * 12);
      reasons.push(`Comparable local outcomes: ${history.succeeded}/${history.total} succeeded (small advisory signal only).`);
    } else {
      reasons.push('No comparable local outcome history was available.');
    }

    suggestions.push({
      agent: profile.id,
      name: profile.name,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      privacyBoundary: profile.privacyBoundary,
      costClass: profile.costClass,
      launchPath: profile.launchPath,
      fallbacks: profile.fallbacks
    });
  }
  suggestions.sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));
  return {
    suggestions: suggestions.map((item, index) => ({ rank: index + 1, ...item })),
    ineligible
  };
}

function printText(result) {
  console.log(`Advisory routing for: ${result.task}`);
  console.log(`Task type: ${result.classification.taskType}; data boundary: ${result.classification.dataBoundary}`);
  console.log('');
  for (const suggestion of result.suggestions) {
    console.log(`${suggestion.rank}. ${suggestion.name} (${suggestion.score})`);
    for (const reason of suggestion.reasons) console.log(`   - ${reason}`);
    console.log(`   - Launch path: ${suggestion.launchPath}`);
  }
  if (result.ineligible.length) {
    console.log('');
    console.log('Not eligible:');
    for (const item of result.ineligible) console.log(`- ${item.name}: ${item.reasons.join(' ')}`);
  }
  console.log('');
  console.log('Advisory only: no agent was launched. Human override always wins.');
}

export async function route(task) {
  const profiles = JSON.parse(await fs.readFile(PROFILES_PATH, 'utf8'));
  const classification = classifyTask(task);
  const [statsResult, outcomesResult] = await Promise.all([
    fetchJson('/api/stats?fresh=1'),
    fetchJson('/api/outcomes')
  ]);
  const usage = usageByAgent(statsResult.data);
  const outcomes = comparableOutcomes(outcomesResult.data, classification.taskType);
  const ranked = rankProfiles(profiles.agents || [], classification, usage, outcomes);
  return {
    version: 1,
    advisoryOnly: true,
    task,
    classification,
    signals: {
      usage: {
        reachable: statsResult.reachable,
        httpStatus: statsResult.status,
        demotionThresholdPercent: HIGH_USAGE
      },
      outcomes: {
        reachable: outcomesResult.reachable,
        httpStatus: outcomesResult.status,
        comparableRows: [...outcomes.values()].reduce((sum, item) => sum + item.total, 0)
      }
    },
    ...ranked
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node tools/route-agent.mjs "<task>" [--json]');
    console.log('Print advisory agent rankings. This command never launches an agent.');
    return;
  }
  const result = await route(opts.task);
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
