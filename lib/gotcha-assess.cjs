'use strict';

const standings = require('./standings.cjs');
const { LEARNED_OPTS, foldLessons, rejectMerged, syncTargets, targetsOf } = require('./gotcha-proposals.cjs');

const TIME_SAVED = Object.freeze({ rare: '<15m/mo saved', monthly: '~30m/mo saved', weekly: '~2h/mo saved', daily: '5h+/mo saved' });
const EFFORT = Object.freeze({ approve: 'Approve only', small: 'Small build', medium: 'Medium build', large: 'Large build' });
const CRITERIA = Object.freeze({ pain: 3, frequency: 2.5, specificity: 2, fit: 1.5, durability: 1 });
const RUBRIC = Object.freeze({
  pain: '0 cosmetic; 5 meaningful rework; 10 blocked/failed run or data loss.',
  frequency: '0 never; rare <1/month; monthly 1-3; weekly 4-11; daily 12+.',
  specificity: '0 vague advice; 10 exact command, path, or flag.',
  fit: '0 wrong skill; 10 belongs here and is read at the decision moment.',
  durability: '0 already-fixed/transient bug; 10 durable guidance.'
});
function round1(n) { return Math.round(n * 10) / 10; }
function rubricScore(scores) { return round1(Object.entries(CRITERIA).reduce((sum, [key, weight]) => sum + weight * scores[key], 0)); }
function validateAssessment(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new TypeError('Assessment must be an object');
  if (typeof a.why !== 'string' || !a.why.trim()) throw new TypeError('Assessment why is required');
  if (a.why.trim().length > 200) throw new RangeError('Assessment why must be 200 characters or fewer');
  if (!Object.hasOwn(TIME_SAVED, a.timeSaved)) throw new TypeError(`Unknown timeSaved category: ${a.timeSaved}; allowed: ${Object.keys(TIME_SAVED).join(', ')}`);
  if (!Object.hasOwn(EFFORT, a.effort)) throw new TypeError(`Unknown effort category: ${a.effort}; allowed: ${Object.keys(EFFORT).join(', ')}`);
  for (const key of ['timeReason', 'effortReason']) if (a[key] != null && typeof a[key] !== 'string') throw new TypeError(`Assessment ${key} must be a string`);
  return true;
}
function recurrenceOf(p) { const n = Number(p?.recurrence); return Number.isFinite(n) && n > 0 ? n : 1; }
function fallbackAssessment(p) {
  const recurrence = recurrenceOf(p), timeSaved = recurrence >= 12 ? 'daily' : recurrence >= 4 ? 'weekly' : recurrence >= 2 ? 'monthly' : 'rare';
  return { why: `Agents hit this ${recurrence}x; the rule stops it repeating.`, timeSaved, effort: 'approve', timeReason: `Estimated from ${recurrence} recurrence${recurrence === 1 ? '' : 's'} per month.`, effortReason: 'The rule itself is the durable fix.', by: 'auto' };
}
function applyAssessments(state, list, { by, now = new Date() } = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('State must be an object');
  if (!Array.isArray(list)) throw new TypeError('Assessments must be an array'); if (typeof by !== 'string' || !by.trim()) throw new TypeError('Assessment author is required');
  const at = new Date(now).toISOString(), proposals = (state.proposals || []).map(p => ({ ...p })), positions = new Map(proposals.map((p, i) => [p.id, i])), applied = [], unknown = [];
  for (const item of list) {
    validateAssessment(item); if (!positions.has(item.id)) { unknown.push(item.id); continue; }
    const assessment = { why: item.why.trim(), timeSaved: item.timeSaved, effort: item.effort, timeReason: String(item.timeReason || '').trim(), effortReason: String(item.effortReason || '').trim(), by: by.trim(), at };
    proposals[positions.get(item.id)] = { ...proposals[positions.get(item.id)], assessment }; applied.push(item.id);
  }
  return { state: { ...state, proposals }, applied, unknown };
}
function packet(store, { batch = 40 } = {}) {
  const open = standings.view(store, { status: 'ranked', limit: 100000, opts: LEARNED_OPTS }).items;
  const latestRun = store.runs.find(run => run.id === store.lastRunId);
  const fresh = open.filter(i => latestRun && i.firstSeen === latestRun.at);
  const incumbents = open.slice(0, 10), unjudged = open.filter(i => !i.data?.judgment);
  const changed = open.filter(i => {
    const judgment = i.data?.judgment;
    return judgment && (i.data.recurrence !== judgment.recurrence ||
      i.data.sourceAt !== judgment.sourceAt ||
      i.evidence.some(e => Date.parse(e.at) > Date.parse(judgment.judgedAt || 0)));
  });
  const chosen = [], seen = new Set();
  for (const item of incumbents) if (!seen.has(item.id)) { seen.add(item.id); chosen.push(item); }
  const more = [...fresh, ...unjudged, ...changed].filter((item, index, all) => all.findIndex(x => x.id === item.id) === index && !seen.has(item.id)).slice(0, Math.max(0, Number.isFinite(batch) ? Math.floor(batch) : 40));
  for (const item of more) { seen.add(item.id); chosen.push(item); }
  // Open items worded like this one: the judge decides whether they are the same lesson (mergeInto) or not.
  const nearby = item => open.filter(o => o.id !== item.id).map(o => ({ id: o.id, text: o.data?.text || `- ${o.title}`, similarity: Math.round(standings.similarity(item.title, o.title) * 100) / 100 }))
    .filter(o => o.similarity >= 0.3).sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  return {
    rubric: { criteria: CRITERIA, anchors: RUBRIC, formula: 'round1(sum(weight * value)); 0-100' },
    answer: {
      format: '{ by, assessments: [{ id, scores, reason, why, timeSaved, effort, timeReason, effortReason, critique, mergeInto, evidenceChecked }] }',
      scores: Object.keys(CRITERIA), timeSaved: Object.keys(TIME_SAVED), effort: Object.keys(EFFORT),
      reason: 'At most 20 words.', critique: 'Required for every item you judge that lands in the resulting top 10.',
      mergeInto: 'Optional open item id when this item is the same lesson as that one, even reworded or filed for other skills (check possibleDuplicates). The two become one entry listing both sets of skills. Do not merge into self or into an item that is itself merging.'
    },
    items: chosen.map(i => {
      const targets = targetsOf(store.items[i.id] || i);
      return { id: i.id, rank: i.rank, tier: i.tier, score: i.score, skill: i.data?.skill || i.category, skills: targets.map(t => t.skill), skillPath: i.data?.file, skillPaths: targets.map(t => t.file).filter(Boolean), text: i.data?.text || `- ${i.title}`, source: i.data?.source || i.refs, recurrence: i.data?.recurrence || 1, firstSeen: i.firstSeen, lastSeen: i.lastSeen, priorJudgment: i.data?.judgment || null, possibleDuplicates: nearby(i) };
    })
  };
}
function words(text) { return String(text || '').trim().split(/\s+/).filter(Boolean).length; }
function validateBatch(store, input) {
  const problems = [], assessments = Array.isArray(input?.assessments) ? input.assessments : [];
  if (typeof input?.by !== 'string' || !input.by.trim()) problems.push('by is required'); if (!Array.isArray(input?.assessments)) problems.push('assessments must be an array');
  const open = new Set(Object.values(store.items).filter(i => i.status === 'open').map(i => i.id)), computed = [];
  for (const [index, a] of assessments.entries()) {
    const label = a?.id || `assessment ${index + 1}`; if (!open.has(a?.id)) problems.push(`${label}: unknown or non-open id`);
    for (const key of Object.keys(CRITERIA)) if (!Number.isInteger(a?.scores?.[key]) || a.scores[key] < 0 || a.scores[key] > 10) problems.push(`${label}: ${key} must be an integer 0-10`);
    if (typeof a?.reason !== 'string' || !a.reason.trim()) problems.push(`${label}: reason is required text`); else if (words(a.reason) > 20) problems.push(`${label}: reason must be at most 20 words`);
    for (const key of ['why', 'timeSaved', 'effort', 'timeReason', 'effortReason']) if (typeof a?.[key] !== 'string' || !a[key].trim()) problems.push(`${label}: ${key} is required text`);
    if (a?.critique != null && typeof a.critique !== 'string') problems.push(`${label}: critique must be text`);
    if (a?.timeSaved && !Object.hasOwn(TIME_SAVED, a.timeSaved)) problems.push(`${label}: invalid timeSaved; allowed: ${Object.keys(TIME_SAVED).join(', ')}`);
    if (a?.effort && !Object.hasOwn(EFFORT, a.effort)) problems.push(`${label}: invalid effort; allowed: ${Object.keys(EFFORT).join(', ')}`);
    if (!Array.isArray(a?.evidenceChecked)) problems.push(`${label}: evidenceChecked must be an array`);
    if (a?.mergeInto && !open.has(a.mergeInto)) problems.push(`${label}: mergeInto is not an open id`);
    if (a?.mergeInto === a?.id && a?.id) problems.push(`${label}: cannot merge into itself`);
    if (a?.scores && Object.keys(CRITERIA).every(k => Number.isInteger(a.scores[k]) && a.scores[k] >= 0 && a.scores[k] <= 10)) computed.push({ id: a.id, score: rubricScore(a.scores), critique: a.critique });
  }
  const merging = new Set(assessments.filter(a => a?.mergeInto).map(a => a.id));
  for (const a of assessments) if (a?.mergeInto && merging.has(a.mergeInto)) problems.push(`${a.id}: merge chains and cycles are not allowed`);
  let simulated = structuredClone(store);
  for (const row of computed) if (Object.hasOwn(simulated.items, row.id)) {
    const item = simulated.items[row.id];
    item.baseScore = row.score;
    item.data = { ...item.data, judgment: { ...item.data?.judgment, critique: String(row.critique || '') } };
  }
  // A merge folds the item into its target, which keeps the higher score and its judgment (as applyJudgments does).
  for (const a of assessments) if (a?.mergeInto && a.mergeInto !== a.id && open.has(a.id) && open.has(a.mergeInto) && !merging.has(a.mergeInto)) simulated = foldLessons(simulated, a.mergeInto, [a.id]).store;
  const ranked = standings.rank(simulated, LEARNED_OPTS); const top = Object.values(ranked.items).filter(i => i.status === 'open').sort((a, b) => a.rank - b.rank).slice(0, 10);
  const byId = new Map(assessments.map(a => [a?.id, a])), uncritiqued = [];
  for (const item of top) {
    if (String(item.data?.judgment?.critique || '').trim()) continue;
    if (byId.has(item.id)) problems.push(`${item.id} (${oneLine(item.title)}): critique is required for a resulting top-10 item`);
    // An item this answer did not judge may not have been in the packet. It keeps its last critique; one with none
    // sits in the next packet's top 10 and gets judged there, instead of failing a batch the judge cannot fix.
    else uncritiqued.push(item.id);
  }
  return { problems, computed, uncritiqued };
}
function oneLine(text) { return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
/* Fold each merging item into its target: one entry per lesson, listing both items' skills. Where both held the same
   skill, the decided proposal stays and a waiting duplicate is rejected as merged into it. state is the proposals file;
   returns the folded store, the updated state and the rejected proposal ids. */
function foldMerges(store, merges, state, at) {
  const next = structuredClone(state || {});
  if (!Array.isArray(next.proposals)) next.proposals = [];
  const byId = new Map(next.proposals.map(p => [p.id, p]));
  // An older item may have no proposal on file yet; file it so the merge is recorded.
  for (const a of merges) for (const t of targetsOf(store.items[a.id])) if (!byId.has(t.proposalId)) {
    const item = store.items[a.id];
    const proposal = { id: t.proposalId, skill: t.skill, file: t.file, section: item.data?.section || 'Gotchas', text: item.data?.text || `- ${item.title}`,
      source: item.data?.source || item.refs, recurrence: item.data?.recurrence || 1, sourceAt: item.data?.sourceAt, status: t.status || 'proposed' };
    next.proposals.push(proposal); byId.set(proposal.id, proposal);
  }
  let result = store; const dropped = [];
  for (const a of merges) { const out = foldLessons(result, a.mergeInto, [a.id], { at, byId }); result = out.store; dropped.push(...out.dropped); }
  const rejected = rejectMerged(next, dropped, at);
  result = syncTargets(result, next, { at, only: new Set(merges.map(a => a.mergeInto)) });
  return { store: result, state: next, rejected };
}
function applyJudgments(store, input, { now = new Date(), state } = {}) {
  const checked = validateBatch(store, input); if (checked.problems.length) return { problems: checked.problems, store };
  const judgedAt = new Date(now).toISOString(), updates = [];
  for (const a of input.assessments) {
    const score = rubricScore(a.scores), assessment = { why: a.why.trim(), timeSaved: a.timeSaved, effort: a.effort, timeReason: a.timeReason.trim(), effortReason: a.effortReason.trim(), by: input.by.trim(), at: judgedAt };
    const item = store.items[a.id];
    const judgment = { scores: a.scores, score, reason: a.reason.trim(), critique: String(a.critique || '').trim(), evidenceChecked: a.evidenceChecked, judgedAt, by: input.by.trim(), recurrence: item.data?.recurrence || 1, sourceAt: item.data?.sourceAt };
    updates.push({ id: a.id, score, scores: a.scores, reason: a.reason.trim(), data: { judgment, assessment } });
  }
  const result = standings.rerank(store, updates, { opts: LEARNED_OPTS });
  const merges = input.assessments.filter(a => a.mergeInto);
  if (!merges.length) return { problems: [], store: result, judged: input.assessments.length, uncritiqued: checked.uncritiqued };
  const folded = foldMerges(result, merges, state, judgedAt);
  return { problems: [], store: folded.store, state: folded.state, rejected: folded.rejected, judged: input.assessments.length, uncritiqued: checked.uncritiqued };
}
/* The proposals side of a judge's merges on its own (tools/gotcha-assess.mjs uses applyJudgments' state). */
function applyMergesToProposals(state, store, assessments, now = new Date()) {
  return foldMerges(store, assessments.filter(a => a.mergeInto), state, new Date(now).toISOString()).state;
}
module.exports = { TIME_SAVED, EFFORT, CRITERIA, RUBRIC, validateAssessment, fallbackAssessment, applyAssessments, rubricScore, packet, validateBatch, applyJudgments, applyMergesToProposals };
