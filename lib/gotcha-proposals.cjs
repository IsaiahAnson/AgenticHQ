'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const standings = require('./standings.cjs');
const { withLock } = require('./store-lock.cjs');
const LOCK_BUSY = 'HQ is updating the Learned board. Try again in a minute.';
const { dateTime } = require('../assets/time12.js');

const SENSITIVE = /(?:\b(?:password|secret|api[_ -]?key|bearer|authorization|account\s*(?:number|#)|phone|e-?mail)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const LEARNED_OPTS = Object.freeze({ matchByCategory: true, recurrencePerDoubling: 0 });
function atomicWrite(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.${Date.now()}.tmp`; fs.writeFileSync(temp, content, 'utf8'); fs.renameSync(temp, file); }
function writeJson(file, value) { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
function normalize(value) { return String(value || '').replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/[`*_~#>\[\]{}()'".,:;!?/\\|+=-]+/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim(); }
function duplicateInSkill(text, skillText) { const needle = normalize(text).replace(/^[- ]+/, ''), haystack = normalize(skillText); return !!needle && needle.length >= 20 && (haystack.includes(needle) || (haystack.length < needle.length && needle.includes(haystack))); }
function parseLessonFile(file, topic) {
  const body = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file);
  const lessons = [];
  const lines = body.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/^\s*-\s+\*\*/.test(line) || /~~/.test(line)) continue;
    const rule = line.match(/^\s*-\s+\*\*(.+?)\*\*/)?.[1]?.trim();
    if (!rule || SENSITIVE.test(rule)) continue;
    const adjacent = [lines[index - 1], line, lines[index + 1]].filter(Boolean)
      .filter(value => value === line || !/^\s*-\s+\*\*/.test(value));
    const stamp = [...adjacent.join(' ').matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].at(-1)?.[1];
    const stampedAt = stamp ? Date.parse(`${stamp}T23:59:59.999Z`) : NaN;
    const refs = [...line.matchAll(/\[ref:\s*([^\]]+)\]/gi)].map(m => m[1].trim());
    lessons.push({
      topic, rule, text: line.trim(), line: index + 1, refs,
      at: Number.isFinite(stampedAt) ? stampedAt : stat.mtimeMs,
      source: [`${file}:${index + 1}`, ...refs]
    });
  }
  return lessons;
}
function parseRegistry(file, { onWarning = message => console.warn(message) } = {}) {
  // Missing reads as no rows (buildProposals checks the file exists first); any other read error aborts the caller.
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error(`Cannot read the failure registry ${file}: ${error.message}`); }
  const lines = body.split(/\r?\n/), headerIndex = lines.findIndex(line => /^\|\s*Fingerprint\s*\|/i.test(line));
  const headers = headerIndex >= 0 ? lines[headerIndex].split('|').slice(1, -1).map(normalize) : [], at = name => headers.indexOf(normalize(name)), rows = [];
  for (const [index, line] of lines.entries()) {
    if (index <= headerIndex + 1 || !line.trim()) continue;
    if (!line.trimStart().startsWith('|')) { onWarning(`Malformed registry row at ${file}:${index + 1}: expected a Markdown table row`); continue; }
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length !== headers.length || !/^`[^`]+`$/.test(cells[0] || '')) { onWarning(`Malformed registry row at ${file}:${index + 1}: expected ${headers.length} cells`); continue; }
    const status = cells[at('Status')] || ''; if (/^(fixed|resolved|retired|dismissed)$/i.test(status.trim())) continue;
    rows.push({ fingerprint: cells[at('Fingerprint')].replace(/`/g, ''), symptom: cells[at('Symptom')], fix: cells[at('Workaround or fix')], scope: cells[at('Scope')], count: Number(cells[at('Count')]) || 1, status, lastSeen: cells[at('Last seen')], evidence: cells[at('Evidence')], line: index + 1, source: [`${file}:${index + 1}`, cells[at('Evidence')]].filter(Boolean) });
  }
  return rows;
}
/* a registry row whose words match a hint also goes to its skills: config/registry-skill-hints.json, [{ "match": "<regex>", "skills": [...] }] */
const REGISTRY_HINTS = [{ match: 'hq|homepage|brain|deck|routine', skills: ['agenticos'] }];
function readRegistryHints(file) {
  try { const hints = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); if (Array.isArray(hints)) return hints; } catch { /* default */ }
  return REGISTRY_HINTS;
}
function registryTargets(row, available, hints = REGISTRY_HINTS) {
  const value = normalize([row.fingerprint, row.symptom, row.scope].join(' ')), wanted = new Set();
  for (const skill of available) if (new RegExp(`\\b${normalize(skill).replace(/ /g, '[ -]')}\\b`).test(value)) wanted.add(skill);
  for (const hint of hints) if (new RegExp(hint.match).test(value)) (hint.skills || []).forEach(s => wanted.add(s));
  return [...wanted].filter(skill => available.includes(skill));
}
function gotchaText(rule) { const clean = String(rule || '').replace(/\s+/g, ' ').trim().replace(/[.:;]+$/, ''); return clean ? `- ${clean}.` : ''; }
function proposalId(skill, sourceText) { return crypto.createHash('sha256').update(`${skill}\n${normalize(sourceText)}`).digest('hex').slice(0, 16); }
function stateDefault() { return { version: 1, lastRunAt: null, proposals: [] }; }
/* The proposals file holds every decision, so an unreadable one stops the caller instead of being rewritten empty. */
function readState(file) {
  let body, state;
  try { body = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return stateDefault(); throw new Error(`Cannot read ${file}: ${error.message}`); }
  try { state = JSON.parse(body.replace(/^﻿/, '')); } catch (error) { throw new Error(`${file} is not valid JSON: ${error.message}`); }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`${file} is not a proposals object`);
  if (state.proposals === undefined) state.proposals = [];
  if (!Array.isArray(state.proposals)) throw new Error(`${file} proposals is not a list`);
  return state;
}
/* An unreadable or empty map would read as "every lesson is gone" and retire them all, so it aborts the run instead. */
function readLessonMap(file) {
  let map;
  try { map = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (error) { throw new Error(`Cannot read the lesson-skill map ${file}: ${error.message}`); }
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error(`The lesson-skill map ${file} is not an object`);
  for (const [topic, targets] of Object.entries(map)) if (!Array.isArray(targets)) throw new Error(`The lesson-skill map topic ${topic} must list skills`);
  if (!Object.values(map).some(targets => targets.length)) throw new Error(`The lesson-skill map ${file} maps no topic to a skill`);
  return map;
}
/* Retired by a run only because its lesson vanished; it comes back when the lesson does. */
function autoRetired(p) { return p?.status === 'rejected' && p.rejectedReason === 'superseded'; }
/* ONE ENTRY PER LESSON. Proposals stay per skill in data/gotcha-proposals.json, so their ids and decisions are unchanged,
   but the standings hold one item per lesson: data.targets lists every skill the Gotcha would go into, each with its
   proposal id and status, and the item stays open while any skill is still waiting. The same lesson filed for several
   skills, or a near-identical rewording, lands on one item; looser rewordings reach the judge as possibleDuplicates
   (lib/gotcha-assess.cjs) and fold on its mergeInto. */
const lessonKey = text => standings.normalizeText(String(text || '').replace(/^\s*-\s*/, ''));
const MARKS = new Set('not no never without nor t dont cannot avoid skip stop instead only'.split(' '));
function lessonShape(text) {
  const key = lessonKey(text), words = key ? key.split(' ').map(w => w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w) : [];
  return { key, count: words.length, words: new Set(words), marks: [...new Set(words.filter(w => MARKS.has(w) || /\d/.test(w)))].sort().join(' ') };
}
/* Same text, or a near-identical rewording: 85% of the words shared (stopwords count) with the same negations and
   numbers, so "do X" and "never do X", or "wait 60s" and "wait 120s", stay apart. */
function sameShape(a, b) {
  if (!a.key || !b.key) return false;
  if (a.key === b.key) return true;
  if (a.count < 6 || b.count < 6 || a.marks !== b.marks) return false;
  let shared = 0; for (const word of a.words) if (b.words.has(word)) shared++;
  return shared / (a.words.size + b.words.size - shared) >= 0.85;
}
function sameLesson(a, b) { return sameShape(lessonShape(a), lessonShape(b)); }
const TARGET_STATUS = { open: 'proposed', approved: 'proposed', done: 'applied', trashed: 'rejected' };
/* An item's skills. Items written before targets existed hold one skill in data.skill, keyed by its proposal id. */
function targetsOf(item) {
  const data = item.data || {};
  if (Array.isArray(data.targets) && data.targets.length) return data.targets.map(target => ({ ...target }));
  return [{ skill: data.skill || item.category || '', file: data.file, proposalId: data.proposalId || item.key, status: TARGET_STATUS[item.status] || 'proposed' }];
}
function proposalIndex(store) {
  const index = new Map();
  for (const item of Object.values(store.items)) {
    for (const id of [...targetsOf(item).map(t => t.proposalId), ...(item.data?.mergedProposalIds || [])]) if (id && !index.has(id)) index.set(id, item.id);
  }
  return index;
}
/* Decided beats waiting: applied, then dismissed by you, then waiting with its lesson still there, then waiting with its
   lesson gone, then retired only because its lesson left. */
function targetWeight(target, byId, currentIds) {
  const proposal = byId.get(target.proposalId), status = proposal?.status || target.status;
  if (status === 'applied') return 4;
  if (status === 'rejected') return autoRetired(proposal) ? 0 : 3;
  return currentIds && !currentIds.has(target.proposalId) ? 1 : 2;
}
/* One target per skill, in first-seen order; returns the same-skill copies it dropped too. */
function pickTargets(list, { byId = new Map(), currentIds } = {}) {
  const bySkill = new Map(), dropped = [];
  for (const target of list) {
    const old = bySkill.get(target.skill);
    if (!old) bySkill.set(target.skill, target);
    else if (old.proposalId !== target.proposalId) {
      if (targetWeight(target, byId, currentIds) > targetWeight(old, byId, currentIds)) { dropped.push(old); bySkill.set(target.skill, target); }
      else dropped.push(target);
    }
  }
  const targets = [...bySkill.values()];
  return { targets, dropped: dropped.map(t => ({ ...t, into: bySkill.get(t.skill).proposalId })) };
}
/* The primary skill first (it keeps data.proposalId, data.skill and data.file for older readers), then the rest A-Z. */
function targetFields(targets, primaryId) {
  const first = targets.find(t => t.proposalId === primaryId) || targets[0];
  const ordered = [first, ...targets.filter(t => t !== first).sort((a, b) => String(a.skill).localeCompare(String(b.skill)))];
  return { targets: ordered, skills: ordered.map(t => t.skill), proposalId: first.proposalId, skill: first.skill, file: first.file };
}
/* Copies of one lesson share its source line, so its recurrence counts once; a lesson line and a registry row add up. */
function combinedRecurrence(rows) {
  const byOrigin = new Map();
  for (const row of rows) {
    const origin = String((row.source || [])[0] || row.id || ''), n = Math.max(1, Number(row.recurrence) || 1);
    byOrigin.set(origin, Math.max(byOrigin.get(origin) || 0, n));
  }
  return [...byOrigin.values()].reduce((sum, n) => sum + n, 0) || 1;
}
const latest = values => values.filter(Boolean).sort().at(-1);
const unionSource = rows => [...new Set(rows.flatMap(row => row.source || []))].slice(0, 20);
/* Fold Learned items into keepId: their skills combine (each keeps its status), the stronger judgment wins, and
   standings.foldItems carries the sightings, evidence, best rank and old ids (store.merges). Returns the store and the
   same-skill proposals it dropped, which the caller rejects as merged into the kept one when they are still waiting. */
function foldLessons(store, keepId, dropIds, { at = null, byId = new Map(), currentIds } = {}) {
  const dropped = [];
  const result = standings.foldItems(store, keepId, dropIds, { at, opts: LEARNED_OPTS, mergeItem(keep, drop) {
    const picked = pickTargets([...targetsOf(keep), ...targetsOf(drop)], { byId, currentIds });
    const k = keep.data || {}, d = drop.data || {}, data = { ...k };
    // foldItems keeps the higher base score, so the judgment behind it comes along.
    if (d.judgment && (!k.judgment || drop.baseScore > keep.baseScore)) { data.judgment = d.judgment; if (d.assessment) data.assessment = d.assessment; }
    else if (!k.assessment && d.assessment) data.assessment = d.assessment;
    const fields = targetFields(picked.targets, k.proposalId || keep.key);
    const merged = [...new Set([...(k.mergedProposalIds || []), ...(d.mergedProposalIds || []), ...picked.dropped.map(t => t.proposalId)])]
      .filter(id => !fields.targets.some(t => t.proposalId === id));
    Object.assign(data, fields, { recurrence: combinedRecurrence([k, d]), sourceAt: latest([k.sourceAt, d.sourceAt]), source: unionSource([k, d]) });
    if (merged.length) data.mergedProposalIds = merged;
    keep.data = data;
    keep.category = fields.skills.join(', ');
    keep.summary = `Recurring lesson for ${keep.category}`;
    dropped.push(...picked.dropped);
  } });
  return { store: result, dropped };
}
/* Which copy survives a fold: the best-ranked open one, then the best rank it ever had, score, age, id. */
function survivorOf(items) {
  const rankOf = value => value ?? Infinity;
  return [...items].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) ||
    rankOf(a.rank) - rankOf(b.rank) || rankOf(a.bestRank) - rankOf(b.bestRank) || b.score - a.score ||
    String(a.firstSeen).localeCompare(String(b.firstSeen)) || String(a.id).localeCompare(String(b.id)))[0];
}
/* A waiting proposal dropped from a fold or a run is the same lesson for a skill that already holds it, so it is rejected
   as merged into the kept one. A waiting one whose lesson is gone is left to the run, which retires it (and can bring it
   back); decided ones stay as they are. */
function rejectMerged(state, dropped, at, currentIds) {
  const rejected = [];
  for (const t of dropped) {
    const p = (state.proposals || []).find(x => x.id === t.proposalId);
    if (!p || p.status !== 'proposed' || (currentIds && !currentIds.has(p.id) && !p.reopenedAt)) continue;
    p.status = 'rejected'; p.rejectedAt = at; p.rejectedReason = `merged into ${t.into}`;
    rejected.push(p.id);
  }
  return rejected;
}
/* Fold every set of items that holds one lesson: same text (title, gotcha or a folded title), a near-identical rewording,
   or a pair named in merges ([keep, drop] item or proposal ids). Runs at the start of every proposals run, so the board
   heals itself, and from tools/learned-dedupe.mjs. Rejects the same-skill copies it drops in state. */
function foldLearnedDuplicates(store, state = stateDefault(), { at = null, merges = [], currentIds } = {}) {
  const byId = new Map((state.proposals || []).map(p => [p.id, p]));
  const items = Object.values(store.items), parent = new Map(items.map(i => [i.id, i.id]));
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const byKey = new Map();
  for (const item of items) for (const text of [item.title, item.data?.text, ...(item.aliases || [])]) {
    const key = lessonKey(text);
    if (!key) continue;
    if (byKey.has(key)) union(byKey.get(key), item.id); else byKey.set(key, item.id);
  }
  const shapes = [...byKey.keys()].map(key => ({ shape: lessonShape(key), id: byKey.get(key) }));
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) if (sameShape(shapes[i].shape, shapes[j].shape)) union(shapes[i].id, shapes[j].id);
  const groups = new Map();
  for (const item of items) { const root = find(item.id); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(item); }
  let result = store; const folds = [], dropped = [];
  const fold = (keep, drops) => {
    const out = foldLessons(result, keep, drops, { at, byId, currentIds });
    result = out.store; dropped.push(...out.dropped);
    folds.push({ keep, drop: drops, skills: result.items[keep].data.skills });
  };
  for (const group of groups.values()) if (group.length > 1) {
    const keep = survivorOf(group);
    fold(keep.id, group.filter(i => i !== keep).map(i => i.id));
  }
  for (const [keepRef, dropRef] of merges) {
    const owner = proposalIndex(result), resolve = ref => standings.resolveId(result, ref) || owner.get(ref) || null;
    const keep = resolve(keepRef), drop = resolve(dropRef);
    if (!keep || !drop) throw new Error(`Unknown Learned item or proposal: ${keep ? dropRef : keepRef}`);
    if (keep !== drop) fold(keep, [drop]);
  }
  return { store: result, folds, dropped, rejected: rejectMerged(state, dropped, at, currentIds) };
}
/* Item statuses follow their skills: open while any skill waits, done once every skill is decided and one was applied,
   trashed when all were dismissed. Target statuses come from the proposals; an item none of whose proposals are on file
   is left as it is. A decided item reopens only when reopen allows it (true, or a set of item ids): a skill came back,
   was added, or you reopened it. notes give the reason for a change, by item id and new status. */
function syncTargets(store, state, { at = null, notes = new Map(), note, only, reopen, opts = LEARNED_OPTS } = {}) {
  const byId = new Map((state.proposals || []).map(p => [p.id, p])), result = structuredClone(store);
  for (const item of Object.values(result.items)) {
    if (only && !only.has(item.id)) continue;
    const targets = targetsOf(item);
    if (!targets.some(t => byId.has(t.proposalId))) continue;
    for (const t of targets) t.status = byId.get(t.proposalId)?.status || t.status || 'proposed';
    Object.assign(item.data = { ...item.data }, targetFields(targets, item.data?.proposalId || item.key));
    item.category = item.data.skills.join(', ');
    const status = targets.some(t => t.status === 'proposed') ? 'open' : targets.some(t => t.status === 'applied') ? 'done' : 'trashed';
    if (status === item.status || !TARGET_STATUS[item.status] || item.status === 'approved') continue;
    if (status === 'open' && reopen !== true && !reopen?.has(item.id)) continue;
    const decided = targets.map(t => byId.get(t.proposalId)).filter(Boolean);
    const merged = status === 'trashed' && decided.map(p => p.rejectedReason).find(r => /^merged into /.test(r || ''));
    const times = { open: ['reopenedAt', 'revivedAt'], done: ['appliedAt'], trashed: ['rejectedAt'] }[status];
    item.status = status;
    item.statusAt = latest(decided.flatMap(p => times.map(key => p[key]))) || at;
    item.note = notes.get(item.id)?.[status] ?? (typeof note === 'string' ? note : merged || '');
  }
  return standings.rank(result, opts);
}
/* Bucket proposals by lesson, then attach each bucket to the item that already holds any of its proposals or its text.
   Items one bucket reaches are folded into one first, and buckets reaching one item become one. */
function groupLessons(proposals, store, { at, byId, currentIds }) {
  const buckets = [];
  for (const p of proposals) {
    const shape = lessonShape(p.text), bucket = buckets.find(b => sameShape(b.shape, shape));
    if (bucket) bucket.proposals.push(p); else buckets.push({ shape, proposals: [p] });
  }
  let result = store; const dropped = [];
  const itemFor = bucket => {
    const owner = proposalIndex(result), byText = new Map(), found = new Set();
    for (const item of Object.values(result.items)) for (const text of [item.title, item.data?.text, ...(item.aliases || [])]) {
      const key = lessonKey(text); if (key && !byText.has(key)) byText.set(key, item.id);
    }
    for (const p of bucket.proposals) { if (owner.has(p.id)) found.add(owner.get(p.id)); const key = lessonKey(p.text); if (byText.has(key)) found.add(byText.get(key)); }
    if (!found.size) for (const item of Object.values(result.items)) if (sameShape(bucket.shape, lessonShape(item.title))) found.add(item.id);
    if (found.size < 2) return [...found][0] || null;
    const keep = survivorOf([...found].map(id => result.items[id]));
    const out = foldLessons(result, keep.id, [...found].filter(id => id !== keep.id), { at, byId, currentIds });
    result = out.store; dropped.push(...out.dropped);
    return keep.id;
  };
  const groups = [];
  for (const bucket of buckets) {
    const itemId = itemFor(bucket), same = itemId && groups.find(g => g.itemId === itemId);
    if (same) same.proposals.push(...bucket.proposals); else groups.push({ itemId, proposals: bucket.proposals });
  }
  return { store: result, groups, dropped };
}
/* The standings candidate for one lesson: its proposals this run plus the skills its item already lists, one per skill. */
function lessonCandidate(proposals, now, oldItem, { byId = new Map(), currentIds } = {}) {
  const ordered = [...proposals].sort((a, b) => (b.recurrence || 1) - (a.recurrence || 1) ||
    Date.parse(b.sourceAt || 0) - Date.parse(a.sourceAt || 0) || String(a.id).localeCompare(String(b.id)));
  const primary = (oldItem && ordered.find(p => lessonKey(p.text) === lessonKey(oldItem.title))) || ordered[0];
  const own = ordered.map(p => ({ skill: p.skill, file: p.file, proposalId: p.id, status: byId.get(p.id)?.status || p.status || 'proposed' }));
  const picked = pickTargets([...(oldItem ? targetsOf(oldItem) : []), ...own], { byId, currentIds });
  const fields = targetFields(picked.targets, oldItem?.data?.proposalId || primary.id);
  // An item's title never changes, so its gotcha text stays the one it was created with.
  const text = oldItem ? (oldItem.data?.text || `- ${oldItem.title}`) : primary.text;
  const recurrence = combinedRecurrence(ordered), sourceAt = latest(ordered.map(p => p.sourceAt)), source = unionSource([primary, ...ordered]);
  const data = { ...fields, section: primary.section || 'Gotchas', text, source, recurrence, sourceAt };
  const merged = [...new Set([...(oldItem?.data?.mergedProposalIds || []), ...picked.dropped.map(t => t.proposalId)])].filter(id => !fields.targets.some(t => t.proposalId === id));
  if (merged.length) data.mergedProposalIds = merged;
  const judgment = oldItem?.data?.judgment, assessment = oldItem?.data?.assessment ?? primary.assessment;
  if (assessment !== undefined) data.assessment = assessment;
  if (judgment !== undefined) data.judgment = judgment;
  const title = text.replace(/^\s*-\s*/, ''), skills = fields.skills.join(', ');
  return { dropped: picked.dropped, candidate: {
    key: oldItem ? oldItem.key : primary.id, ...(oldItem ? { mergeInto: oldItem.id } : {}),
    title, category: skills, summary: `Recurring lesson for ${skills}`, ref: source[0], refs: source,
    evidence: { text: title, source: primary.sourceName || primary.id },
    data, score: judgment?.score ?? heuristicScore({ ...primary, text, recurrence, sourceAt }, now), reason: judgment?.reason || ''
  } };
}
function selectProposals(candidates) { return candidates.slice(); }
function reconcileTrashed(state, artifactsDir) {
  let changed = 0;
  for (const p of state.proposals || []) if (p.status === 'proposed' && p.report && !fs.existsSync(path.join(artifactsDir, p.report)) && fs.existsSync(path.join(artifactsDir, '_trash', p.report))) { p.status = 'rejected'; p.rejectedAt = new Date().toISOString(); changed++; }
  return changed;
}
/* 15 base + up to 20 recurrence + 10 recency + up to 10 for concrete commands, paths and flags. */
function heuristicScore(item, now = new Date()) {
  const recurrence = Math.max(1, Number(item.recurrence) || 1);
  const recurrencePoints = Math.min(20, Math.log2(recurrence + 1) * 5);
  const parsedAt = Date.parse(item.sourceAt || '');
  const ageDays = Number.isFinite(parsedAt) ? Math.max(0, (new Date(now).getTime() - parsedAt) / 864e5) : 3650;
  const recencyPoints = Math.max(0, 10 - ageDays / 36.5);
  const text = item.text || '';
  const concrete = (/`[^`]+`|\b(?:node|npm|git|orca|python|pwsh|curl)\b/i.test(text) ? 5 : 0) +
    (/(?:^|\s)--?[a-z][\w-]*/i.test(text) ? 3 : 0) +
    (/[A-Za-z]:\\|(?:^|\s)[./~][\w./\\-]+/i.test(text) ? 2 : 0);
  return Math.min(55, Math.round((15 + recurrencePoints + recencyPoints + concrete) * 10) / 10);
}
function candidateProposals({ lessonsDir, registryFile, skillsRoot, lessonSkillMap, registryHints, since = 0, existing = [], now = new Date() }) {
  void since;
  // Applied, dismissed and merged proposals stay decided; an auto-retired one is offered again when its lesson returns.
  const decided = new Set(existing.filter(p => p.status === 'applied' || (p.status === 'rejected' && !autoRetired(p))).map(p => p.id));
  const available = fs.readdirSync(skillsRoot, { withFileTypes: true }).filter(e => fs.existsSync(path.join(skillsRoot, e.name, 'SKILL.md'))).map(e => e.name);
  const missing = [...new Set(Object.values(lessonSkillMap).flat())].filter(skill => !available.includes(skill));
  if (missing.length) throw new Error(`lesson-skill map targets missing personal skills: ${missing.join(', ')}`);
  const candidates = [];
  for (const [topic, targets] of Object.entries(lessonSkillMap)) {
    const sourceFile = path.join(lessonsDir, `${topic}.md`);
    if (!targets.length) continue;
    if (!fs.existsSync(sourceFile)) throw new Error(`The lesson file for mapped topic ${topic} is missing: ${sourceFile}`);
    for (const lesson of parseLessonFile(sourceFile, topic)) for (const skill of targets) {
      const file = path.join(skillsRoot, skill, 'SKILL.md');
      const text = gotchaText(lesson.rule);
      if (duplicateInSkill(text, fs.readFileSync(file, 'utf8'))) continue;
      const previous = existing.find(p => p.skill === skill && p.text === text);
      const id = previous?.id || proposalId(skill, lesson.text);
      if (decided.has(id)) continue;
      candidates.push({
        id, skill, file, section: 'Gotchas', text, source: lesson.source, status: 'proposed',
        recurrence: Math.max(1, lesson.refs.length), sourceAt: new Date(lesson.at).toISOString(), sourceName: topic
      });
    }
  }
  for (const row of parseRegistry(registryFile)) for (const skill of registryTargets(row, available, registryHints)) {
    const file = path.join(skillsRoot, skill, 'SKILL.md');
    const text = gotchaText(`${row.symptom} ${row.fix}`);
    if (SENSITIVE.test(text) || duplicateInSkill(text, fs.readFileSync(file, 'utf8'))) continue;
    const id = proposalId(skill, `${row.fingerprint}\n${row.symptom}\n${row.fix}`);
    if (decided.has(id)) continue;
    const lastSeen = Date.parse(row.lastSeen || '');
    const sourceAt = Number.isFinite(lastSeen) ? lastSeen : fs.statSync(registryFile).mtimeMs;
    candidates.push({
      id, skill, file, section: 'Gotchas', text, source: row.source, status: 'proposed',
      recurrence: row.count, sourceAt: new Date(sourceAt).toISOString(), sourceName: row.fingerprint
    });
  }
  return candidates.sort((a, b) => b.recurrence - a.recurrence || Date.parse(b.sourceAt) - Date.parse(a.sourceAt) || a.id.localeCompare(b.id));
}
/* Older name for syncTargets: item statuses follow their proposals. */
function migrateStatuses(store, state) { return syncTargets(store, state); }
function esc(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function reportHtml(view, generatedAt) {
  const rows = view.items.slice(0, 10).map(i => `<tr><td>#${i.rank}</td><td>${esc(i.tier)}</td><td>${esc(i.movement)}</td><td>${i.score}</td><td>${esc(i.category)}</td><td>${esc(i.title)}</td><td>${esc(i.reason || 'Awaiting deeper judgment')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>What HQ Learned standings</title>
  <style>@font-face{font-family:Outfit;src:url('/assets/outfit.woff2')}@font-face{font-family:Doto;src:url('/assets/doto.woff2')}*{box-sizing:border-box}:root{color-scheme:dark;--bg:#050504;--panel:#11100e;--ink:#e8e2d2;--muted:#aaa38f;--line:#353127;--accent:#ff6b1a}body{margin:0;color:var(--ink);font:400 16px/1.55 Outfit,system-ui,sans-serif;background:radial-gradient(circle at 75% -20%,#2a160b 0,transparent 34rem),var(--bg)}main{width:min(1100px,calc(100% - 40px));margin:auto;padding:64px 0 96px}h1{font-size:clamp(2.4rem,6vw,4.8rem);line-height:.96;letter-spacing:-.03em}p,footer{color:var(--muted)}.table{overflow-x:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--accent)}footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:.82rem}::selection{background:var(--accent);color:#160a03}</style></head>
  <body><main><h1>What HQ Learned</h1><p>${view.counts.open} open · ${view.counts.done} applied · ${view.counts.trashed} dismissed</p><div class="table"><table><thead><tr><th>Rank</th><th>Tier</th><th>Move</th><th>Score</th><th>Skill</th><th>Gotcha</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div><footer>Generated ${esc(dateTime(generatedAt))}</footer></main></body></html>`;
}
// The local day: an evening run is already tomorrow in UTC (7 PM EST is midnight UTC).
const localDay = at => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
function writeReport({ artifactsDir, store, generatedAt, reportName }) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const day = localDay(generatedAt);
  const htmlName = reportName || `gotcha-proposals-${day}.html`;
  const jsonName = htmlName.replace(/\.html$/, '.json');
  const view = standings.view(store, { status: 'ranked', limit: 10, opts: LEARNED_OPTS });
  atomicWrite(path.join(artifactsDir, htmlName), reportHtml(view, generatedAt));
  writeJson(path.join(artifactsDir, jsonName), {
    title: `What HQ Learned · ${day}`, icon: 'doc', kind: 'report',
    created: generatedAt, note: `${view.counts.open} open · ${view.counts.done} applied · ${view.counts.trashed} dismissed`,
    svg: '<path d="M14 8h16l5 5v27H14z"/><path d="M30 8v7h7M19 23h11M19 29h11M19 35h7"/>'
  });
  return { htmlName, jsonName };
}
function buildProposals({ root, skillsRoot = path.join(os.homedir(), '.claude', 'skills'), lessonsDir = path.join(require('./places.cjs').companions, 'knowledge', 'lessons'), registryFile = path.join(require('./places.cjs').companions, 'knowledge', 'hq-failure-registry.md'), standingsFile, dryRun = false, now = new Date(), lockTimeoutMs = 60000 } = {}) {
  const configFile = path.join(root, 'config', 'lesson-skill-map.json');
  const dataFile = path.join(root, 'data', 'gotcha-proposals.json');
  standingsFile ||= path.join(root, 'data', 'standings', 'learned.json');
  const artifactsDir = path.join(root, 'artifacts');
  const run = () => {
  // Every source is read before anything is written: a bad read throws here and leaves the state and standings as they were.
  const state = readState(dataFile);
  const lessonSkillMap = readLessonMap(configFile);
  if (!fs.existsSync(registryFile)) throw new Error(`The failure registry is missing: ${registryFile}`);
  const registryHints = readRegistryHints(path.join(root, 'config', 'registry-skill-hints.json'));
  const candidates = candidateProposals({ lessonsDir, registryFile, skillsRoot, lessonSkillMap, registryHints, existing: state.proposals, now });
  const oldStore = standings.load(standingsFile, 'learned');
  const currentIds = new Set(candidates.map(p => p.id));
  const generatedAt = now.toISOString();
  const notes = new Map(), noteFor = (itemId, status, text) => { if (itemId) notes.set(itemId, { ...notes.get(itemId), [status]: text }); };
  const revived = new Set();
  for (const p of state.proposals) if (currentIds.has(p.id) && autoRetired(p)) {
    p.status = 'proposed'; p.revivedAt = generatedAt; delete p.rejectedAt; delete p.rejectedReason; revived.add(p.id);
  }
  const known = new Set(state.proposals.map(p => p.id));
  for (const p of candidates) if (!known.has(p.id)) state.proposals.push({ ...p, proposedAt: generatedAt });
  const byId = new Map(state.proposals.map(p => [p.id, p]));
  // One item per lesson: fold the copies already on the board, then file this run's proposals by lesson.
  const healed = foldLearnedDuplicates(oldStore, state, { at: generatedAt, currentIds });
  const held = proposalIndex(healed.store);
  const missing = state.proposals.filter(p => !currentIds.has(p.id) && !held.has(p.id) && p.text && p.skill);
  const grouped = groupLessons([...candidates, ...missing], healed.store, { at: generatedAt, byId, currentIds });
  let store = grouped.store;
  const built = grouped.groups.map(g => ({ ...lessonCandidate(g.proposals, now, g.itemId ? store.items[g.itemId] : null, { byId, currentIds }), current: g.proposals.some(p => currentIds.has(p.id)) }));
  rejectMerged(state, [...grouped.dropped, ...built.flatMap(b => b.dropped)], generatedAt, currentIds);
  // Proposals with no item yet (older runs) get one; ones whose lesson an item already holds join it without a sighting.
  const sighted = built.filter(b => b.current || !b.candidate.mergeInto), attached = built.filter(b => !sighted.includes(b));
  const standCandidates = sighted.map(b => b.candidate);
  store = standings.mergeRun(store, standCandidates, { runId: generatedAt, at: generatedAt, opts: LEARNED_OPTS });
  // The engine ignores empty runs; preserve decay even when nothing is currently eligible.
  if (!standCandidates.length) {
    store = structuredClone(store);
    for (const item of Object.values(store.items)) { item.prevRank = item.rank; item.missedRuns++; }
    store.lastRunId = generatedAt;
    store.updatedAt = generatedAt;
    store.runs.push({ id: generatedAt, at: generatedAt, candidates: 0, added: 0, merged: 0 });
    store.runs = store.runs.slice(-60);
  }
  for (const b of attached) {
    const item = store.items[b.candidate.mergeInto];
    if (item) Object.assign(item, { data: { ...item.data, ...b.candidate.data }, category: b.candidate.category, summary: b.candidate.summary });
  }
  for (const b of sighted) if (!b.current) {
    const item = Object.values(store.items).find(i => i.key === b.candidate.key);
    if (item) item.missedRuns = 1;
  }
  const owner = proposalIndex(store);
  for (const p of state.proposals) {
    if (currentIds.has(p.id) || p.status !== 'proposed') continue;
    const duplicate = p.file && fs.existsSync(p.file) && duplicateInSkill(p.text, fs.readFileSync(p.file, 'utf8'));
    // Reopened from the Learned page: it stays open after its lesson is gone, until the skill itself has it.
    if (!duplicate && p.reopenedAt) continue;
    const note = duplicate ? 'already in SKILL.md' : 'no longer in the lessons';
    p.status = duplicate ? 'applied' : 'rejected';
    if (duplicate) { p.appliedAt = generatedAt; p.appliedReason = note; }
    else { p.rejectedAt = generatedAt; p.rejectedReason = 'superseded'; }
    noteFor(owner.get(p.id), duplicate ? 'done' : 'trashed', note);
  }
  // A decided item reopens when one of its skills is back in the lessons or newly waiting on it (a skill added to the map).
  const reopen = new Set();
  for (const [pid, itemId] of owner) {
    if (revived.has(pid)) { reopen.add(itemId); noteFor(itemId, 'open', 'back in the lessons'); }
    else if (!held.has(pid) && byId.get(pid)?.status === 'proposed') { reopen.add(itemId); noteFor(itemId, 'open', `new for ${byId.get(pid).skill}`); }
  }
  // Each item's status follows its skills: open while any waits, done once one was applied, trashed when all were dismissed.
  store = syncTargets(store, state, { at: generatedAt, notes, reopen });
  if (dryRun) return { dryRun: true, proposals: candidates, candidateCount: candidates.length, lessonCount: built.length, stateChanged: false, store, top: standings.view(store, { status: 'ranked', limit: 10, opts: LEARNED_OPTS }).items };
  state.lastRunAt = generatedAt;
  const report = writeReport({ artifactsDir, store, generatedAt });
  if (store.runs.length) store.runs[store.runs.length - 1].report = report.htmlName;
  standings.save(standingsFile, store);
  writeJson(dataFile, state);
  return { dryRun: false, proposals: candidates, candidateCount: candidates.length, lessonCount: built.length, report, dataFile, standingsFile, store,
    top: standings.view(store, { status: 'ranked', limit: 10, opts: LEARNED_OPTS }).items };
  };
  return dryRun ? run() : withLock(standingsFile, run, { timeoutMs: lockTimeoutMs });
}
function insertGotcha(content, text) {
  if (duplicateInSkill(text, content)) return { content, duplicate: true }; const heading = /^## Gotchas[^\r\n]*$/m.exec(content);
  if (!heading) return { content: content.replace(/\s*$/, '') + `\n\n## Gotchas\n\n${text}\n`, duplicate: false };
  const start = heading.index + heading[0].length, rest = content.slice(start), next = /\n##\s+/.exec(rest), at = next ? start + next.index : content.length;
  return { content: content.slice(0, at).replace(/\s*$/, '') + `\n${text}\n\n` + content.slice(at).replace(/^\s*/, ''), duplicate: false };
}
function gitRoot(dir) { try { const root = path.resolve(execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()); return root === path.resolve(dir) ? root : null; } catch (_) { return null; } }
/* After proposals are applied, dismissed or reopened: the items holding them follow their skills (syncTargets), with
   note on the ones whose status changes. Returns those items. */
function syncStandings(standingsFile, state, ids, at, note, { reopen = false } = {}) {
  if (!standingsFile) return [];
  return withLock(standingsFile, () => {
    let store = standings.load(standingsFile, 'learned');
    const owner = proposalIndex(store), only = new Set(ids.map(id => owner.get(id)).filter(Boolean));
    if (!only.size) return [];
    store = syncTargets(store, state, { at, note, only, reopen });
    standings.save(standingsFile, store);
    return [...only].map(id => store.items[id]);
  });
}
/* One proposal's skill set to an item status (done, trashed, open); the item follows all of its skills. */
function syncStandingStatus(standingsFile, proposalIdValue, status, at, note) {
  if (!standingsFile) return null;
  return withLock(standingsFile, () => {
    const store = standings.load(standingsFile, 'learned'), id = proposalIndex(store).get(proposalIdValue);
    if (!id) return null;
    const proposals = targetsOf(store.items[id]).map(t => ({ id: t.proposalId, status: t.proposalId === proposalIdValue ? TARGET_STATUS[status] || 'proposed' : t.status }));
    return syncStandings(standingsFile, { proposals }, [proposalIdValue], at, note, { reopen: status === 'open' })[0] || null;
  });
}
function proposalError(status, message) {
  return Object.assign(new Error(message), { status });
}
function applyProposals({ ids, dataFile, standingsFile, skillsRoot = path.join(os.homedir(), '.claude', 'skills'), commit = true, now = new Date(), lockTimeoutMs = 3000 } = {}) {
  standingsFile ||= path.join(path.dirname(dataFile), 'standings', 'learned.json');
  if (!Array.isArray(ids)) throw proposalError(400, 'Provide 1 to 5 proposal ids');
  return withLock(standingsFile, () => {
  const state = readState(dataFile);
  const wanted = [...new Set(ids.map(String))];
  if (!wanted.length || wanted.length > 5) throw proposalError(400, 'Provide 1 to 5 proposal ids');
  const applied = [];
  for (const id of wanted) {
    const p = (state.proposals || []).find(x => x.id === id);
    if (!p) throw proposalError(404, `Unknown proposal: ${id}`);
    if (p.status !== 'proposed') throw proposalError(409, `Proposal ${id} is ${p.status}`);
    if (typeof p.skill !== 'string' || typeof p.file !== 'string' || typeof p.text !== 'string') throw proposalError(400, `Proposal ${id} is invalid`);
    const expected = path.resolve(skillsRoot, p.skill, 'SKILL.md');
    if (path.resolve(p.file) !== expected || !expected.startsWith(path.resolve(skillsRoot) + path.sep)) throw proposalError(400, `Proposal ${id} is outside the personal skills root`);
    let before;
    try { before = fs.readFileSync(expected, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw proposalError(404, `Skill file not found for proposal ${id}`);
      throw error;
    }
    const next = insertGotcha(before, p.text);
    const repo = gitRoot(skillsRoot);
    if (!repo) fs.copyFileSync(expected, expected + '.bak');
    if (!next.duplicate) atomicWrite(expected, next.content);
    p.status = 'applied';
    p.appliedAt = now.toISOString();
    if (repo && commit && !next.duplicate) {
      execFileSync('git', ['-C', repo, 'add', '--', expected], { windowsHide: true });
      execFileSync('git', ['-C', repo, 'commit', '-m', `Apply Gotcha proposal ${id} to ${p.skill}`], { windowsHide: true });
    }
    applied.push({ id, skill: p.skill, file: expected, duplicate: next.duplicate, backup: repo ? null : expected + '.bak', commit: !!(repo && commit) });
  }
  writeJson(dataFile, state);
  syncStandings(standingsFile, state, wanted, now.toISOString());
  return { applied };
  }, { timeoutMs: lockTimeoutMs, busyMessage: LOCK_BUSY });
}
function dismissProposals({ ids, dataFile, standingsFile, now = new Date(), lockTimeoutMs = 3000 } = {}) {
  standingsFile ||= path.join(path.dirname(dataFile), 'standings', 'learned.json');
  if (!Array.isArray(ids)) throw proposalError(400, 'Provide 1 to 5 proposal ids');
  return withLock(standingsFile, () => {
  const state = readState(dataFile);
  const wanted = [...new Set(ids.map(String))];
  if (!wanted.length || wanted.length > 5) throw proposalError(400, 'Provide 1 to 5 proposal ids');
  for (const id of wanted) {
    const p = (state.proposals || []).find(x => x.id === id);
    if (!p) throw proposalError(404, `Unknown proposal: ${id}`);
    if (p.status !== 'proposed') throw proposalError(409, `Proposal ${id} is ${p.status}`);
  }
  const dismissed = [];
  for (const id of wanted) {
    const p = state.proposals.find(x => x.id === id);
    p.status = 'rejected';
    p.rejectedAt = now.toISOString();
    p.rejectedBy = 'widget';
    dismissed.push({ id, skill: p.skill });
  }
  writeJson(dataFile, state);
  syncStandings(standingsFile, state, wanted, now.toISOString());
  return { dismissed };
  }, { timeoutMs: lockTimeoutMs, busyMessage: LOCK_BUSY });
}
module.exports = { LEARNED_OPTS, LOCK_BUSY, SENSITIVE, applyProposals, atomicWrite, buildProposals, candidateProposals, dismissProposals, duplicateInSkill, foldLearnedDuplicates, foldLessons, gotchaText, heuristicScore, insertGotcha, lessonCandidate, lessonKey, migrateStatuses, normalize, parseLessonFile, parseRegistry, proposalId, proposalIndex, readState, reconcileTrashed, registryTargets, rejectMerged, reportHtml, sameLesson, selectProposals, stateDefault, syncStandingStatus, syncStandings, syncTargets, targetsOf, writeReport };
