'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { loadVoiceState, parseSessionNote } = require('../lib/voice-sessions.cjs');

const NOTE = `# Voice session 2026-10-28
## Ideas
- A private idea.
## Decisions
- Build the queue.
## Action items
- Build \`hq-one\` and \`hq-two\` (both in handoffs\\specs\\).
- Decide whether to keep a suggested item (inferred).
  - Next step: this indented line is not another item.
---
## Session 2
### Decisions
- Keep launching manual.
### Action items
- Follow up without a spec.
### Open questions
- Should the queue auto-launch?
`;

test('parser extracts sessions, inferred items, and one row per named spec', () => {
  const root = path.join(os.tmpdir(), 'voice-parser');
  const result = parseSessionNote(NOTE, { date: '2026-10-28', specPaths: [path.join(root, 'hq-one.md'), path.join(root, 'hq-two.md')] });
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].actions.length, 3);
  assert.deepEqual(result.sessions[0].actions.slice(0, 2).map(item => path.basename(item.specPath)), ['hq-one.md', 'hq-two.md']);
  assert.equal(result.sessions[0].actions[2].inferred, true);
  assert.equal(result.sessions[1].questions.length, 1);
});

test('voice state derives done, building, drafted, open, and override statuses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-state-'));
  const voiceDir = path.join(root, 'voice'), specsDir = path.join(root, 'specs'), dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(voiceDir, 'sessions'), { recursive: true }); fs.mkdirSync(specsDir); fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(voiceDir, 'sessions', '2026-10-28.md'), NOTE);
  for (const name of ['hq-one.md', 'hq-two.md']) fs.writeFileSync(path.join(specsDir, name), '# spec');
  const parsed = parseSessionNote(NOTE, { date: '2026-10-28', specPaths: [path.join(specsDir, 'hq-one.md'), path.join(specsDir, 'hq-two.md')] });
  const inferred = parsed.sessions[0].actions[2];
  fs.writeFileSync(path.join(dataDir, 'voice-items.json'), JSON.stringify({ [inferred.id]: 'dropped' }));
  fs.writeFileSync(path.join(dataDir, 'voice-queue.json'), JSON.stringify({ items: [path.join(specsDir, 'hq-one.md'), path.join(specsDir, 'hq-two.md')], completed: [] }));
  const state = loadVoiceState({ root, voiceDir, specsDir, dataDir, artifactsDir: path.join(root, 'artifacts'), now: Date.parse('2026-10-28T22:00:00Z'),
    commits: [{ hash: 'abc1234', at: '2026-10-28T18:00:00Z', subject: 'Implement hq-one spec' }],
    agents: [{ agent: 'codex', prompt: `work on ${path.join(specsDir, 'hq-two.md')}`, startedAt: Date.parse('2026-10-28T21:00:00Z') }] });
  assert.equal(state.queue[0].status, 'done'); assert.equal(state.queue[1].status, 'building');
  assert.equal(state.actions.find(item => item.id === inferred.id).status, 'dropped');
  assert.equal(state.actions.find(item => !item.specPath && !item.inferred).status, 'open');
  assert.equal(state.building.agent, 'codex');
  const advanced = loadVoiceState({ root, voiceDir, specsDir, dataDir, artifactsDir: path.join(root, 'artifacts'), now: Date.parse('2026-10-28T22:00:00Z'), advanceQueue: true,
    commits: [{ hash: 'abc1234', at: '2026-10-28T18:00:00Z', subject: 'Implement hq-one spec' }],
    agents: [{ agent: 'codex', prompt: `work on ${path.join(specsDir, 'hq-two.md')}`, startedAt: Date.parse('2026-10-28T21:00:00Z') }] });
  assert.equal(advanced.advanced.length, 1); assert.equal(advanced.queueHead.name, 'hq-two');
});

test('missing private voice folder returns a quiet empty state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-empty-'));
  assert.deepEqual(loadVoiceState({ root, voiceDir: path.join(root, 'voice'), specsDir: path.join(root, 'specs') }), { available: false, empty: true, message: 'No voice sessions yet' });
});
