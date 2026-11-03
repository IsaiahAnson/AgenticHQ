'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../assets/time12.js');

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slug = value => String(value || '').toLowerCase().replace(/\.md$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

function parseSessionNote(markdown, { date = '', specPaths = [] } = {}) {
  const known = specPaths.map(file => ({ path: path.resolve(file), stem: path.basename(file, path.extname(file)).toLowerCase() }));
  const sessions = [];
  let current = { number: 1, label: 'Session 1', ideas: [], decisions: [], actions: [], questions: [] };
  let section = '';
  const finish = () => { if ([current.ideas, current.decisions, current.actions, current.questions].some(list => list.length)) sessions.push(current); };
  for (const raw of String(markdown || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const session = /^##\s+Session\s+(\d+)(.*)$/i.exec(raw);
    if (session) {
      finish();
      current = { number: Number(session[1]), label: `Session ${session[1]}${session[2] || ''}`.trim(), ideas: [], decisions: [], actions: [], questions: [] };
      section = '';
      continue;
    }
    const heading = /^#{2,3}\s+(Ideas|Decisions|Action items|Open questions)\s*$/i.exec(raw);
    if (heading) { section = heading[1].toLowerCase().replace(/\s+/g, '-'); continue; }
    const bullet = /^-\s+(.+?)\s*$/.exec(raw);
    if (!bullet || !section) continue;
    const text = bullet[1].trim(), inferred = /\(inferred\)/i.test(text);
    if (section === 'ideas') current.ideas.push(text);
    else if (section === 'decisions') current.decisions.push(text);
    else if (section === 'open-questions') current.questions.push(text);
    else if (section === 'action-items') {
      const matches = known.filter(spec => text.toLowerCase().includes(spec.stem));
      const actionIndex = current.actions.length + 1;
      if (!matches.length) current.actions.push({ id: `voice:${date}:s${current.number}:a${actionIndex}`, text, date, session: current.number, inferred, specPath: null });
      else for (const spec of matches) current.actions.push({ id: `voice:${date}:s${current.number}:a${actionIndex}:${slug(spec.stem)}`, text, date, session: current.number, inferred, specPath: spec.path });
    }
  }
  finish();
  return { date, sessions };
}

function gitCommits(repoDir) {
  try {
    const raw = execFileSync('git', ['log', '-200', '--format=%H%x00%cI%x00%s'], { cwd: repoDir, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return raw.trim().split(/\r?\n/).filter(Boolean).map(line => { const [hash, at, ...subject] = line.split('\0'); return { hash, at, subject: subject.join('\0') }; });
  } catch { return []; }
}

function liveOrcaAgents() {
  try {
    const raw = execFileSync('orca', ['worktree', 'ps', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 << 20 });
    const body = JSON.parse(raw), agents = [];
    for (const worktree of body?.result?.worktrees || []) for (const agent of worktree.agents || []) {
      if (agent.state !== 'working' && agent.mainAgent?.state !== 'working') continue;
      agents.push({ agent: agent.agentType || 'agent', prompt: String(agent.prompt || ''), startedAt: Number(agent.stateStartedAt || agent.mainAgent?.stateStartedAt) || null, workspace: worktree.path || '' });
    }
    return agents;
  } catch { return []; }
}

function matchingCommit(specPath, commits) {
  const file = path.basename(specPath).toLowerCase(), stem = path.basename(specPath, path.extname(specPath)).toLowerCase();
  return commits.find(commit => String(commit.subject || '').toLowerCase().includes(file) || String(commit.subject || '').toLowerCase().includes(stem)) || null;
}

function matchingAgent(specPath, agents) {
  const file = path.basename(specPath).toLowerCase(), stem = path.basename(specPath, path.extname(specPath)).toLowerCase(), full = path.resolve(specPath).toLowerCase();
  return agents.find(agent => { const prompt = String(agent.prompt || '').toLowerCase(); return prompt.includes(full) || prompt.includes(file) || prompt.includes(stem); }) || null;
}

function statusFor(specPath, commits, agents) {
  const commit = matchingCommit(specPath, commits);
  if (commit) return { status: 'done', commit };
  const agent = matchingAgent(specPath, agents);
  if (agent) return { status: 'building', agent: agent.agent, startedAt: agent.startedAt };
  return { status: 'drafted' };
}

function normalizeQueue(value) {
  if (Array.isArray(value)) return { items: value, completed: [] };
  return { items: Array.isArray(value?.items) ? value.items : [], completed: Array.isArray(value?.completed) ? value.completed : [] };
}

function loadVoiceState({ root, voiceDir = path.join(root, 'voice'), specsDir, dataDir = path.join(root, 'data'), artifactsDir = path.join(root, 'artifacts'), commits, agents, now = Date.now(), syncQueue = false, advanceQueue = false } = {}) {
  if (!fs.existsSync(voiceDir)) return { available: false, empty: true, message: 'No voice sessions yet' };
  const notesDir = path.join(voiceDir, 'sessions');
  let noteFiles = []; try { noteFiles = fs.readdirSync(notesDir).filter(name => /^\d{4}-\d{2}-\d{2}\.md$/i.test(name)).sort(); } catch { }
  if (!noteFiles.length) return { available: false, empty: true, message: 'No voice sessions yet' };
  let specPaths = []; try { specPaths = fs.readdirSync(specsDir).filter(name => name.endsWith('.md')).map(name => path.resolve(specsDir, name)); } catch { }
  const days = noteFiles.map(file => parseSessionNote(fs.readFileSync(path.join(notesDir, file), 'utf8'), { date: file.slice(0, 10), specPaths }));
  const allCommits = commits || gitCommits(root), liveAgents = agents || liveOrcaAgents();
  const overrides = readJson(path.join(dataDir, 'voice-items.json'), {});
  const actions = days.flatMap(day => day.sessions.flatMap(session => session.actions)).map(item => {
    const override = typeof overrides[item.id] === 'string' ? overrides[item.id] : overrides[item.id]?.status;
    if (override === 'done' || override === 'dropped') return { ...item, status: override, override: true };
    return item.specPath ? { ...item, ...statusFor(item.specPath, allCommits, liveAgents) } : { ...item, status: 'open' };
  });
  const bySpec = new Map(actions.filter(item => item.specPath).map(item => [path.resolve(item.specPath).toLowerCase(), item]));
  const queueFile = path.join(dataDir, 'voice-queue.json');
  const queue = normalizeQueue(readJson(queueFile, { items: [], completed: [] }));
  const knownQueue = new Set([...queue.items, ...queue.completed.map(item => item.path || item)].map(item => path.resolve(typeof item === 'string' ? item : item.path).toLowerCase()));
  if (syncQueue) for (const item of actions) if (item.specPath && !item.inferred && !knownQueue.has(path.resolve(item.specPath).toLowerCase())) {
    queue.items.push(item.specPath); knownQueue.add(path.resolve(item.specPath).toLowerCase());
  }
  /* Orca bounds long prompts. If its visible prefix names this approved batch, the first
     unfinished item is the one building after all earlier items in that batch are committed. */
  const queueAgent = liveAgents.find(agent => queue.items.some(value => matchingAgent(path.resolve(typeof value === 'string' ? value : value.path), [agent]))
    || (agent.workspace && path.resolve(agent.workspace).toLowerCase() === path.resolve(root).toLowerCase() && /\bspecs?\b/i.test(agent.prompt)));
  const queueRows = () => {
    const generated = queue.items.map(value => {
    const specPath = path.resolve(typeof value === 'string' ? value : value.path), action = bySpec.get(specPath.toLowerCase());
    return { path: specPath, name: path.basename(specPath, path.extname(specPath)), ...(action ? { status: action.status, commit: action.commit, agent: action.agent, startedAt: action.startedAt } : statusFor(specPath, allCommits, liveAgents)) };
    });
    if (queueAgent && !generated.some(row => row.status === 'building')) {
      const next = generated.find(row => row.status === 'drafted');
      if (next) Object.assign(next, { status: 'building', agent: queueAgent.agent, startedAt: queueAgent.startedAt });
    }
    return generated;
  };
  const advanced = [];
  if (advanceQueue) {
    for (;;) {
      const head = queueRows()[0]; if (!head || head.status !== 'done') break;
      queue.items.shift();
      const completed = { path: head.path, at: new Date(now).toISOString(), commit: head.commit?.hash || null };
      queue.completed.push(completed); advanced.push({ ...head, completedAt: completed.at });
    }
  }
  if ((syncQueue || advanceQueue) && (advanced.length || queue.items.length || queue.completed.length)) {
    fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(queueFile, JSON.stringify(queue, null, 2) + '\n');
  }
  const rows = queueRows(), latestDay = days.at(-1), latestSession = latestDay.sessions.at(-1);
  for (const row of rows) if (row.status === 'building') {
    const action = bySpec.get(row.path.toLowerCase());
    if (action && action.status === 'drafted') Object.assign(action, { status: 'building', agent: row.agent, startedAt: row.startedAt });
  }
  const lastAt = fs.statSync(path.join(notesDir, noteFiles.at(-1))).mtimeMs;
  const built = specPaths.map(specPath => ({ specPath, result: statusFor(specPath, allCommits, liveAgents) }))
    .filter(row => row.result.status === 'done' && Date.parse(row.result.commit.at) >= Date.parse(`${latestDay.date}T00:00:00`))
    .map(row => ({ name: path.basename(row.specPath, path.extname(row.specPath)), path: row.specPath, commit: row.result.commit.hash, at: row.result.commit.at,
      reportUrl: `/artifacts/voice-session-${latestDay.date}.html#${slug(path.basename(row.specPath, path.extname(row.specPath)))}` }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const openInferred = actions.filter(item => item.inferred && !['done', 'dropped'].includes(item.status));
  const openActions = actions.filter(item => !['done', 'dropped'].includes(item.status));
  const questions = days.flatMap(day => day.sessions.flatMap(session => session.questions.map(text => ({ date: day.date, session: session.number, text }))));
  const building = rows.find(row => row.status === 'building') || actions.find(item => item.status === 'building');
  return {
    available: true, date: latestDay.date, lastAt: new Date(lastAt).toISOString(), notePath: path.join(notesDir, noteFiles.at(-1)),
    decisions: latestSession.decisions.slice(-3), openItemCount: openActions.length,
    queue: rows.slice(0, 3), queueHead: rows[0] || null,
    building: building ? { name: building.name || path.basename(building.specPath, path.extname(building.specPath)), agent: building.agent || 'agent', startedAt: building.startedAt || null,
      runningMs: building.startedAt ? Math.max(0, now - building.startedAt) : null } : null,
    openInferred, questions, needsCallCount: openInferred.length + questions.length, built, actions, days, advanced,
    reportFile: path.join(artifactsDir, `voice-session-${latestDay.date}.html`)
  };
}

function publicVoiceState(state) {
  if (!state.available) return state;
  const cleanItem = item => ({ id: item.id, text: item.text, date: item.date, session: item.session, inferred: item.inferred, specPath: item.specPath, status: item.status, commit: item.commit?.hash || null });
  return { available: true, date: state.date, lastAt: state.lastAt, notePath: state.notePath, decisions: state.decisions, openItemCount: state.openItemCount,
    queue: state.queue.map(row => ({ name: row.name, path: row.path, status: row.status, commit: row.commit?.hash || null, agent: row.agent || null, startedAt: row.startedAt || null })),
    queueHead: state.queueHead ? { name: state.queueHead.name, status: state.queueHead.status } : null, building: state.building,
    openInferred: state.openInferred.map(cleanItem), questions: state.questions, needsCallCount: state.needsCallCount, built: state.built };
}

function writeVoiceReport(state) {
  if (!state.available) return null;
  const day = state.days.at(-1), status = new Map(state.actions.map(item => [item.id, item]));
  const lists = (items, map) => `<ul>${items.map((item, index) => `<li>${map ? map(item, index) : esc(item)}</li>`).join('') || '<li class="muted">None recorded.</li>'}</ul>`;
  const sessions = day.sessions.map(session => `<section><h2>${esc(session.label)}</h2><div class="cols"><div><h3>Ideas</h3>${lists(session.ideas)}</div><div><h3>Decisions</h3>${lists(session.decisions)}</div></div><h3>Action items</h3>${lists(session.actions, item => {
    const row = status.get(item.id) || item, name = item.specPath ? path.basename(item.specPath, path.extname(item.specPath)) : '';
    return `<span id="${esc(slug(name || item.id))}">${esc(item.text)}</span> <span class="chip ${esc(row.status)}">${esc(row.status)}</span>${row.commit?.hash ? ` <code>${esc(row.commit.hash.slice(0, 7))}</code>` : ''}`;
  })}</section>`).join('');
  const built = state.built.length ? `<section><h2>Built since last talk</h2>${lists(state.built, item => `<span id="${esc(slug(item.name))}">${esc(item.name)}</span> <span class="chip done">done</span> <code>${esc(item.commit.slice(0, 7))}</code>`)}</section>` : '';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voice session ${esc(day.date)}</title><style>
  :root{color-scheme:dark;--bg:#080b1c;--panel:#0d122c;--ink:#d5ddff;--muted:#8892bd;--line:#27315e;--violet:#a37cff;--cyan:#7ff0ff;--green:#4fd58a;--amber:#ffae42}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif;padding:42px 18px}.wrap{max-width:940px;margin:auto}h1{font-size:32px;margin:0 0 6px}h2{font-size:20px;margin:30px 0 12px;color:var(--cyan)}h3{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:18px 0 8px}.sub,.muted{color:var(--muted)}section{border-top:1px solid var(--line);padding-top:4px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:28px}li{margin:7px 0}.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 7px;font:600 11px/1.2 ui-monospace,monospace;text-transform:uppercase}.done{color:var(--green)}.building{color:var(--cyan)}.drafted,.open{color:var(--amber)}.dropped{color:var(--muted)}code{color:var(--violet)}@media(max-width:650px){.cols{grid-template-columns:1fr}}
  </style><main class="wrap"><p class="sub">Agentic HQ · private local voice intake</p><h1>Voice session ${esc(day.date)}</h1><p class="sub">Updated ${esc(T.dateTime(new Date(), { year: true }))}. Status is derived from local commits, the live Orca agent, and local overrides.</p>${built}${sessions}</main></html>`;
  fs.mkdirSync(path.dirname(state.reportFile), { recursive: true }); fs.writeFileSync(state.reportFile, html);
  const sidecar = state.reportFile.replace(/\.html$/i, '.json'), previous = readJson(sidecar, {});
  fs.writeFileSync(sidecar, JSON.stringify({ title: `Voice session ${day.date}`, icon: 'mic', kind: 'report', created: previous.created || new Date().toISOString(),
    note: 'Ideas, decisions and action items with derived build status', svg: '<rect x="17" y="7" width="14" height="23" rx="7"/><path d="M11 23v2a13 13 0 0 0 26 0v-2M24 38v5M17 43h14"/>' }, null, 2));
  return state.reportFile;
}

module.exports = { gitCommits, liveOrcaAgents, loadVoiceState, parseSessionNote, publicVoiceState, statusFor, writeVoiceReport };
