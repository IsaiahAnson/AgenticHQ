'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const standings = require('../lib/standings.cjs');
const { asCp437, fixCp437, fixDeep } = require('../lib/mojibake.cjs');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'radar-fix-mojibake.mjs');
const temp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-mojibake-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('fixCp437 undoes UTF-8 that was read as code page 437', () => {
  assert.equal(fixCp437('CLEO worktree lifecycle specification ΓÇö canonical agent worktree contract'),
    'CLEO worktree lifecycle specification — canonical agent worktree contract');
  assert.equal(fixCp437('OrcaΓÇÖs lifecycle'), 'Orca’s lifecycle');
  assert.equal(fixCp437('ΓÇ£markdownΓÇ¥ wikiΓÇª'), '“markdown” wiki…');
  assert.equal(fixCp437('edit ┬╖ skills'), 'edit · skills');
  assert.equal(fixCp437('launch ≡ƒÜÇ caf├⌐'), 'launch 🚀 café');
  assert.equal(fixCp437('kept — fixed ΓÇö'), 'kept — fixed —');
  for (const s of ['OpenKnowledge — agent-native “markdown” wiki…', 'It’s · 🚀 → café × naïve ½', 'Łódź Ωμέγα привет']) {
    assert.equal(fixCp437(asCp437(s)), s);
  }
});

test('fixCp437 leaves text that was never mangled', () => {
  for (const s of ['', 'plain ascii', 'em — dash', 'café über', 'é', 'ü alone', '┌──┐', '████▓▓░░', 'Γ alone', 'ΓÇ', 'ΓÇ cut short', '┬Ç']) {
    assert.equal(fixCp437(s), s);
  }
});

test('fixDeep repairs nested strings, skips the keys it is given and reports each change', () => {
  const value = { id: 'ΓÇö', title: 'A ΓÇö B', list: ['x', 'ItΓÇÖs'], n: 3, ok: true, none: null, nested: { refs: ['ΓÇö'], why: 'ΓÇª' } };
  const seen = [];
  const out = fixDeep(value, { skip: ['id', 'refs'], onFix: (at, before, after) => seen.push([at, before, after]) });
  assert.deepEqual(out, { id: 'ΓÇö', title: 'A — B', list: ['x', 'It’s'], n: 3, ok: true, none: null, nested: { refs: ['ΓÇö'], why: '…' } });
  assert.deepEqual(seen, [['title', 'A ΓÇö B', 'A — B'], ['list.1', 'ItΓÇÖs', 'It’s'], ['nested.why', 'ΓÇª', '…']]);
  assert.equal(value.title, 'A ΓÇö B', 'the input is left as it was');
});

test('radar-fix-mojibake repairs standings, runs and latest through their own writers, once', async t => {
  const { writeJsonAtomic } = await import('../tools/ai-radar.mjs');
  const { fixRadarMojibake } = await import('../tools/radar-fix-mojibake.mjs');
  const dir = temp(t), url = 'https://github.com/inkeep/open-knowledge', bad = 'OpenKnowledge ΓÇö agent-native markdown wiki';
  const store = standings.emptyStore('radar');
  store.items['rad-1'] = { id: 'rad-1', key: 'gh:inkeep/open-knowledge', title: bad, refs: [url], aliases: [],
    data: { sources: [{ id: 'deepseek-web', url, signal: 'OrcaΓÇÖs wiki' }] } };
  store.items['rad-2'] = { id: 'rad-2', key: 'gh:a/b', title: 'Clean — title', refs: [], aliases: [] };
  standings.save(path.join(dir, 'standings.json'), store);
  writeJsonAtomic(path.join(dir, 'runs', '20261101-0700.json'), { runId: '20261101-0700', findings: [{ id: 'x', title: bad }] });
  writeJsonAtomic(path.join(dir, 'runs', '20261101-1900.json'), { runId: '20261101-1900', findings: [{ id: 'y', title: 'Clean' }] });
  writeJsonAtomic(path.join(dir, 'latest.json'), { runId: '20261101-1900', findings: [] });
  const snap = () => Object.fromEntries(['standings.json', 'latest.json', 'runs/20261101-0700.json', 'runs/20261101-1900.json']
    .map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const before = snap();

  const dry = fixRadarMojibake({ dir, dryRun: true });
  assert.equal(dry.count, 3);
  assert.deepEqual(dry.files.map(f => [f.name, f.changes.map(c => c.at)]),
    [['standings.json', ['items.rad-1.title', 'items.rad-1.data.sources.0.signal']], ['runs/20261101-0700.json', ['findings.0.title']]]);
  assert.deepEqual(snap(), before, 'a dry run writes nothing');

  assert.equal(fixRadarMojibake({ dir }).count, 3);
  const after = snap(), fix = s => s.replaceAll('ΓÇö', '—').replaceAll('ΓÇÖ', '’');
  assert.deepEqual(after, Object.fromEntries(Object.entries(before).map(([f, s]) => [f, fix(s)])), 'only the mangled strings change');
  const item = standings.load(path.join(dir, 'standings.json'), 'radar').items['rad-1'];
  assert.equal(item.title, 'OpenKnowledge — agent-native markdown wiki');
  assert.equal(item.key, 'gh:inkeep/open-knowledge');

  assert.equal(fixRadarMojibake({ dir }).count, 0);
  assert.deepEqual(snap(), after, 'a second run changes nothing');
});

test('radar-fix-mojibake waits for a Radar run that holds status.json', async t => {
  const { fixRadarMojibake } = await import('../tools/radar-fix-mojibake.mjs');
  const dir = temp(t);
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ running: true, pid: process.pid }));
  assert.throws(() => fixRadarMojibake({ dir, dryRun: true }), { code: 'RADAR_RUNNING' });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ running: false, pid: process.pid }));
  assert.equal(fixRadarMojibake({ dir, dryRun: true }).count, 0);
});

test('radar-fix-mojibake CLI prints the dry-run report and rejects unknown flags', t => {
  const dir = temp(t);
  fs.mkdirSync(path.join(dir, 'runs'));
  fs.writeFileSync(path.join(dir, 'runs', '20261101-0700.json'), JSON.stringify({ findings: [{ title: 'ruflo ΓÇö recall' }] }, null, 2) + '\n');
  const r = spawnSync(process.execPath, [TOOL, '--dry-run', '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run: 1 string in 1 file to fix/);
  assert.match(r.stdout, /findings\.0\.title\n {4}ruflo ΓÇö recall\n {4}-> ruflo — recall/);
  assert.match(fs.readFileSync(path.join(dir, 'runs', '20261101-0700.json'), 'utf8'), /ΓÇö/);
  assert.equal(spawnSync(process.execPath, [TOOL, '--bogus'], { encoding: 'utf8' }).status, 2);
});
