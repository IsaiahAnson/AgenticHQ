'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { applyProposals, candidateProposals, duplicateInSkill, parseRegistry, reconcileTrashed, selectProposals, writeReport } = require('../lib/gotcha-proposals.cjs');
const { emptyStore } = require('../lib/standings.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotcha-proposals-'));
  const lessonsDir = path.join(root, 'lessons'), skillsRoot = path.join(root, 'skills');
  fs.mkdirSync(lessonsDir); fs.mkdirSync(skillsRoot);
  return { root, lessonsDir, skillsRoot, registryFile: path.join(root, 'registry.md') };
}
function skill(root, name, body = '# Skill\n') { const dir = path.join(root, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'SKILL.md'), body); return path.join(dir, 'SKILL.md'); }

test('topic mapping creates proposals only for mapped personal skills', () => {
  const f = fixture(); skill(f.skillsRoot, 'agenticos'); skill(f.skillsRoot, 'reason');
  fs.writeFileSync(path.join(f.lessonsDir, 'hq-operations.md'), '- **Verify live HQ before editing**: evidence. [ref: one, 2026-10-28] (verified 2026-10-28)\n'); fs.writeFileSync(f.registryFile, '');
  const rows = candidateProposals({ ...f, lessonSkillMap: { 'hq-operations': ['agenticos'], 'windows-pc': [] } });
  assert.equal(rows.length, 1); assert.equal(rows[0].skill, 'agenticos');
});
test('normalized duplicate check suppresses punctuation and markdown variants', () => {
  assert.equal(duplicateInSkill('- Verify live HQ before editing.', '## Gotchas\n- **Verify live HQ before editing!**'), true);
  assert.equal(duplicateInSkill('- Verify live HQ before editing.', '## Gotchas\n- Keep reports short.'), false);
});
test('proposal selection keeps every candidate with no special review lane', () => {
  const f = fixture(); skill(f.skillsRoot, 'agenticos');
  const lines = Array.from({ length: 8 }, (_, i) => `- **Lesson number ${i} must be handled safely**: evidence. ${'[ref: proof, 2026-10-28] '.repeat(i + 1)}(verified 2026-10-28)`);
  fs.writeFileSync(path.join(f.lessonsDir, 'hq-operations.md'), lines.join('\n')); fs.writeFileSync(f.registryFile, '');
  const candidates = candidateProposals({ ...f, lessonSkillMap: { 'hq-operations': ['agenticos'] } });
  const rows = selectProposals(candidates, 5);
  assert.equal(rows.length, 8); assert.match(rows[0].text, /number 7/); assert.ok(rows.some(row => row.skill === 'agenticos'));
});
test('trash marks proposed ids rejected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotcha-trash-')); fs.mkdirSync(path.join(root, '_trash'));
  fs.writeFileSync(path.join(root, '_trash', 'gotcha-proposals-2026-10-28.html'), 'trashed');
  const state = { proposals: [{ id: 'one', status: 'proposed', report: 'gotcha-proposals-2026-10-28.html' }, { id: 'two', status: 'applied', report: 'gotcha-proposals-2026-10-28.html' }] };
  assert.equal(reconcileTrashed(state, root), 1); assert.equal(state.proposals[0].status, 'rejected'); assert.equal(state.proposals[1].status, 'applied');
});
test('the ring report takes the local day, not the UTC one', t => {
  const tz = process.env.TZ; process.env.TZ = 'America/New_York';
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gotcha-report-'));
  // 7:30 PM on Nov 1 in New York is already Nov 2 in UTC.
  const report = writeReport({ artifactsDir: root, store: emptyStore('learned'), generatedAt: '2026-11-02T00:30:00.000Z' });
  assert.equal(report.htmlName, 'gotcha-proposals-2026-11-01.html');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, report.jsonName), 'utf8')).title, 'What HQ Learned · 2026-11-01');
});

test('a rejected lesson-skill pair is not proposed again', () => {
  const f = fixture(); skill(f.skillsRoot, 'agenticos');
  fs.writeFileSync(path.join(f.lessonsDir, 'hq-operations.md'), '- **Verify the live endpoint before editing**: evidence. [ref: one, 2026-10-28] (verified 2026-10-28)\n'); fs.writeFileSync(f.registryFile, '');
  const first = candidateProposals({ ...f, lessonSkillMap: { 'hq-operations': ['agenticos'] } });
  assert.equal(first.length, 1);
  const next = candidateProposals({ ...f, lessonSkillMap: { 'hq-operations': ['agenticos'] }, existing: [{ ...first[0], status: 'rejected' }] });
  assert.equal(next.length, 0);
});

test('malformed registry rows warn with their line number while valid rows continue', () => {
  const f = fixture(), warnings = [];
  fs.writeFileSync(f.registryFile, [
    '| Fingerprint | Symptom | Verified cause | Workaround or fix | Scope | First seen | Last seen | Count | Status | Evidence |',
    '|---|---|---|---|---|---|---|---:|---|---|',
    'broken row',
    '| `valid` | symptom | cause | fix | HQ | 2026-10-29 | 2026-10-29 | 1 | active | proof |',
  ].join('\n'));
  const rows = parseRegistry(f.registryFile, { onWarning: message => warnings.push(message) });
  assert.equal(rows.length, 1);
  assert.match(warnings[0], /:3:/);
});

test('explicit apply updates a scratch skill, writes a backup, and marks the id applied', () => {
  const f = fixture(); const file = skill(f.skillsRoot, 'agenticos', '# Skill\n\n## Usage\n\nDo work.\n');
  const dataFile = path.join(f.root, 'gotcha-proposals.json');
  fs.writeFileSync(dataFile, JSON.stringify({ version: 1, proposals: [{ id: 'scratch-one', skill: 'agenticos', file, section: 'Gotchas', text: '- Verify the live endpoint before editing.', source: ['fixture'], status: 'proposed' }] }));
  const result = applyProposals({ ids: ['scratch-one'], dataFile, skillsRoot: f.skillsRoot, commit: false });
  assert.match(fs.readFileSync(file, 'utf8'), /## Gotchas\n\n- Verify the live endpoint before editing\./);
  assert.equal(fs.existsSync(file + '.bak'), true);
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).proposals[0].status, 'applied');
  assert.equal(result.applied[0].id, 'scratch-one');
});
