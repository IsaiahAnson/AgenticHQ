#!/usr/bin/env node
// Agent-facing task context packet. HQ handles retrieval and holds the optional API key.
const args = process.argv.slice(2);
const ai = args.includes('--ai'), json = args.includes('--json');
const agentArg = args.find(x => x.startsWith('--agent='));
const agent = agentArg ? agentArg.slice(8) : 'cli';
const task = args.filter(x => !['--ai', '--json'].includes(x) && !x.startsWith('--agent=')).join(' ').trim();
if (task.length < 3) { console.error('Usage: node tools/hq-context.mjs "task to prepare" [--ai] [--json] [--agent=codex]'); process.exit(2); }

try {
  const port = Number(process.env.HQ_PORT || process.env.PORT) || 50000;
  const headers = { 'content-type': 'application/json' };
  if (process.env.RUBRIC_TOKEN) headers['x-rubric-token'] = process.env.RUBRIC_TOKEN;
  const response = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST', headers, body: JSON.stringify({ task, ai, agent }), signal: AbortSignal.timeout(ai ? 90000 : 60000)
  });
  const pack = await response.json();
  if (!response.ok) throw new Error(pack.aiError || pack.error || `HQ HTTP ${response.status}`);
  if (json) console.log(JSON.stringify(pack, null, 2));
  else {
    console.log(`Context for: ${pack.task}\nSources: ${pack.sourceCount}`);
    if (pack.live) console.log(`Live HQ: engine=${pack.live.engine}, runner=${pack.live.runner}, companions=${JSON.stringify(pack.live.companions)}`);
    for (const topic of pack.authorities || []) console.log(`Authority for ${topic.id}: ${topic.canonical.map(x => x.path + (x.exists ? '' : ' [MISSING]')).join(', ')}; check ${topic.live.join(', ')}`);
    if (pack.retrieval?.contentCoverage) console.log(`Content index: ${pack.retrieval.contentCoverage.indexed}/${pack.retrieval.contentCoverage.eligible} eligible text files${pack.retrieval.contentCoverage.truncated ? ' (size cap reached)' : ''}`);
    for (const s of pack.sources) console.log(`\n[${s.id}] ${s.path}:${s.lineStart} (${s.authority}${s.canonical ? ', canonical' : ''}, modified ${s.modifiedAt})\n${s.text}`);
    if (pack.synthesis) console.log(`\nClaude synthesis (${pack.synthesis.model}):\n${pack.synthesis.answer}`);
    else console.log('\nUse the sources above; verify current state before acting. Add --ai for an optional Claude summary of curated sources.');
  }
} catch (error) { console.error(`HQ context failed: ${error.message}`); process.exitCode = 1; }
