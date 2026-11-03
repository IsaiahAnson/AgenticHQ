#!/usr/bin/env node
// Ben AI's four-question effort choice for new Codex or Copilot CLI tasks.
// Unlike Claude's in-process mod, these clients apply the choice at launch.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
const { recordLocalUsage } = createRequire(import.meta.url)('../lib/anthropic-local-usage.cjs');

const LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLASSIFIER = `Choose an AI coding agent's reasoning effort for ONE user task. Apply the first matching rule:
1. Back and forth or simple task (brainstorm, rewrite, short summary, small tweak): low.
2. A hidden mistake could cost money, trust, a client, or a wrong decision (fact checks, contracts, verification, building or fixing skills): high.
3. Long, hard, critical work handed off without interaction: xhigh. Use max only when the user explicitly asks for the deepest work and says it is critical.
4. Everything else: medium. Length alone does not make a task high.
An approval, answer to a question, or "continue" keeps the current effort.
Reply JSON only: {"level":"low|medium|high|xhigh|max|keep","why":"under 12 words"}.`;

export function parseArgs(argv) {
  const opts = { agent: '', classifier: 'rules', mode: 'suggest', current: 'medium', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (['--agent', '--classifier', '--mode', '--current-effort', '--prompt', '--prompt-file'].includes(a)) {
      if (!argv[i + 1]) throw new Error(`${a} needs a value`);
      opts[a === '--current-effort' ? 'current' : a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (!['codex', 'copilot'].includes(opts.agent)) throw new Error('--agent must be codex or copilot');
  if (!['rules', 'local', 'claude'].includes(opts.classifier)) throw new Error('--classifier must be rules, local, or claude');
  if (!['suggest', 'auto'].includes(opts.mode)) throw new Error('--mode must be suggest or auto');
  if (!LEVELS.has(opts.current)) throw new Error('--current-effort is invalid');
  if (!!opts.prompt === !!opts.promptFile) throw new Error('Give exactly one of --prompt or --prompt-file');
  return opts;
}

export function parseChoice(raw, current) {
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Classifier did not return JSON');
  const data = JSON.parse(match[0]);
  if (data.level !== 'keep' && !LEVELS.has(data.level)) throw new Error('Classifier returned an invalid effort');
  return { level: data.level === 'keep' ? current : data.level, why: String(data.why || '').slice(0, 100), kept: data.level === 'keep' };
}

export function classifyRules(prompt, current) {
  const text = prompt.toLowerCase();
  const words = text.trim().split(/\s+/).length;
  const keep = /^(yes|yep|ok|okay|go ahead|continue|do it|option \d+)[.!\s]*$/.test(text.trim());
  if (keep) return { level: current, why: 'continuing earlier work', kept: true };
  const simple = /\b(brainstorm|rewrite|reword|short summary|summarize|sort|tag|small tweak|simple question|rough draft)\b/.test(text) && words < 120;
  if (simple) return { level: 'low', why: 'simple or back-and-forth task', kept: false };
  const costly = /\b(contract|legal|medical|financial|money|security|audit|fact.check|verify|verification|test|testing|risk|critical decision)\b/.test(text)
    || /\b(build|fix|repair|debug)\b[\s\S]{0,50}\b(skill|plugin|integration)\b/.test(text);
  if (costly) return { level: 'high', why: 'hidden mistakes could matter', kept: false };
  const critical = /\b(critical|high.stakes|mission.critical)\b/.test(text);
  const handoff = /\b(walk away|no questions|without interaction|one.shot|autonomous handoff)\b/.test(text);
  const long = /\b(long|large|full report|50.page|entire|comprehensive)\b/.test(text) || words > 300;
  if (critical && handoff && long) {
    return { level: /\b(deepest|max effort|maximum effort)\b/.test(text) ? 'max' : 'xhigh',
      why: 'long critical handoff without interaction', kept: false };
  }
  return { level: 'medium', why: 'standard task', kept: false };
}

async function classify(prompt, opts) {
  if (opts.classifier === 'rules') return classifyRules(prompt, opts.current);
  const request = `${CLASSIFIER}\nCurrent effort: ${opts.current}\nTask:\n<task>\n${prompt.slice(0, 6000)}\n</task>`;
  if (opts.classifier === 'claude') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is required for --classifier claude');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 140, messages: [{ role: 'user', content: request }] }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Claude API HTTP ${response.status}`);
    const data = await response.json();
    recordLocalUsage({ source: 'effort-optimizer', model: data.model, usage: data.usage });
    return parseChoice((data.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), opts.current);
  }
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen3.5-text:9b', prompt: request, format: 'json', stream: false,
      options: { num_predict: 140, temperature: 0 } }), signal: AbortSignal.timeout(60000)
  });
  if (!response.ok) throw new Error(`Local classifier HTTP ${response.status}`);
  const data = await response.json();
  return parseChoice(data.response, opts.current);
}

export function commandFor(agent, level, prompt) {
  if (!LEVELS.has(level)) throw new Error('Invalid effort');
  return agent === 'codex'
    ? { file: 'codex', args: ['--config', `model_reasoning_effort="${level}"`, prompt] }
    : { file: 'copilot', args: ['--reasoning-effort', level, '--interactive', prompt] };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prompt = opts.promptFile ? fs.readFileSync(opts.promptFile, 'utf8').trim() : opts.prompt.trim();
  if (!prompt) throw new Error('The task prompt is empty');
  const choice = await classify(prompt, opts);
  let level = choice.level;
  if (opts.mode === 'suggest' && level !== opts.current && !opts.dryRun) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`Suggested ${level} (${choice.why}). Switch from ${opts.current}? [Y/n] `);
      if (/^n(o)?$/i.test(answer.trim())) level = opts.current;
    } finally { rl.close(); }
  }
  console.log(JSON.stringify({ agent: opts.agent, classifier: opts.classifier, recommended: choice.level,
    selected: level, reason: choice.why, mode: opts.mode, applied: !opts.dryRun }));
  if (opts.dryRun) return;
  const command = commandFor(opts.agent, level, prompt);
  let file = command.file, args = command.args;
  if (opts.agent === 'copilot' && process.platform === 'win32') {
    const loader = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@github', 'copilot', 'npm-loader.js');
    if (!fs.existsSync(loader)) throw new Error('Copilot npm loader was not found; install or update Copilot CLI');
    file = process.execPath;
    args = [loader, ...args];
  }
  const child = spawn(file, args, { stdio: 'inherit', shell: false, windowsHide: false });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code || 0; });
}

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\').toLowerCase() === process.argv[1].toLowerCase()) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
