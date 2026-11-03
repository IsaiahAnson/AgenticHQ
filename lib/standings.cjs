'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  tiers: [
    { tier: 'S', maxRank: 3 }, { tier: 'A', maxRank: 10 },
    { tier: 'B', maxRank: 25 }, { tier: 'C', maxRank: 50 },
    { tier: 'D', maxRank: Infinity }
  ],
  rankedStatuses: ['open'],
  hysteresis: 6, incumbentTop: 10, blendNew: 0.6,
  recurrencePerDoubling: 4, recurrenceCap: 12,
  decayPerMissedRun: 1.5, decayFloor: 0.6,
  mergeThreshold: 0.6, matchByCategory: false,
  maxEvidence: 12, maxHistory: 20, maxRuns: 60
});
const STATUSES = Object.freeze(['open', 'approved', 'done', 'trashed']);
const STOPWORDS = new Set('a an and are as at be by for from has have how i in into is it its of on or that the this to was were when with without you your'.split(' '));
const options = opts => ({ ...DEFAULTS, ...opts });
const round1 = n => Math.round(n * 10) / 10;
const clamp = n => Math.max(0, Math.min(100, n));
const tail = (array, count) => count > 0 ? array.slice(-count) : [];
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const error = (code, message) => Object.assign(new Error(message), { code });

function normalizeText(s) {
  return String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]/g, ' ').replace(/ +/g, ' ').trim();
}

function tokens(s) {
  const result = [];
  for (let word of normalizeText(s).split(' ')) {
    if (!word || STOPWORDS.has(word)) continue;
    if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
    else if (word.length > 4 && word.endsWith('ed')) word = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
    else if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
    if (!result.includes(word)) result.push(word);
  }
  return result;
}

function similarity(a, b) {
  const left = new Set(tokens(a)), right = new Set(tokens(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}

function itemId(board, key) {
  return String(board).slice(0, 3).toLowerCase() + '-' +
    crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
}

function emptyStore(board) {
  return { version: 1, board, updatedAt: null, lastRunId: null, runs: [], items: {} };
}

function findMatch(store, cand, opts) {
  const config = options(opts), items = Object.values(store.items);
  if (cand.mergeInto && Object.hasOwn(store.items, cand.mergeInto)) return cand.mergeInto;
  if (cand.key != null) {
    const exactKey = items.find(item => item.key === String(cand.key));
    return exactKey ? exactKey.id : null;
  }
  if (typeof cand.ref === 'string' && cand.ref.trim()) {
    const refMatch = items.find(item => item.refs.includes(cand.ref));
    if (refMatch) return refMatch.id;
  }
  const eligible = config.matchByCategory
    ? items.filter(item => normalizeText(item.category) === normalizeText(cand.category)) : items;
  const key = cand.key == null ? normalizeText(cand.title) : String(cand.key);
  const exact = eligible.find(item => item.key === key);
  if (exact) return exact.id;
  let best = null, bestScore = -1;
  for (const item of eligible) {
    const score = Math.max(...[item.title, ...item.aliases].map(title => similarity(cand.title, title)));
    if (score < config.mergeThreshold) continue;
    if (score > bestScore || (score === bestScore &&
      (!best || item.seenCount > best.seenCount ||
        (item.seenCount === best.seenCount && compareText(item.id, best.id) < 0)))) {
      best = item;
      bestScore = score;
    }
  }
  return best ? best.id : null;
}

function effectiveScore(item, opts) {
  const config = options(opts);
  const bonus = Math.min(config.recurrenceCap, config.recurrencePerDoubling * Math.log2(Math.max(1, item.seenCount)));
  const decay = Math.min(item.baseScore * (1 - config.decayFloor), config.decayPerMissedRun * item.missedRuns);
  return round1(clamp(item.baseScore + bonus - decay));
}

function addEvidence(item, evidence, runId, at, maxEvidence) {
  const entries = Array.isArray(evidence) ? evidence : [evidence];
  for (const entry of entries) {
    const text = typeof entry === 'string' ? entry : entry && entry.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    if (item.evidence.some(old => normalizeText(old.text) === normalizeText(text))) continue;
    item.evidence.push({ text, source: entry && entry.source || '', run: runId, at });
  }
  item.evidence = tail(item.evidence, maxEvidence);
}

function mergeRun(store, candidates, { runId, at, opts } = {}) {
  if (!runId || !at || typeof at !== 'string' || typeof runId !== 'string') {
    throw error('STANDINGS_BAD_RUN', 'A run id and timestamp are required');
  }
  const config = options(opts), result = structuredClone(store);
  const valid = (Array.isArray(candidates) ? candidates : [])
    .filter(c => c && typeof c.title === 'string' && c.title.trim() && typeof c.score === 'number' && Number.isFinite(c.score));
  if (!valid.length) return result;
  for (const item of Object.values(result.items)) item.prevRank = item.rank;
  const matched = new Set(), runState = new Map();
  let added = 0, merged = 0;
  for (const cand of valid) {
    const title = cand.title.trim(), score = clamp(cand.score);
    const key = cand.key == null ? normalizeText(title) : String(cand.key);
    let id = findMatch(result, cand, config);
    if (!id) id = itemId(result.board, config.matchByCategory && cand.key == null ? key + '|' + normalizeText(cand.category) : key);
    let item = result.items[id];
    if (!item) {
      item = {
        id, key, title, summary: cand.summary || '', category: cand.category || '',
        refs: [...new Set([...(Array.isArray(cand.refs) ? cand.refs : []), ...(typeof cand.ref === 'string' && cand.ref.trim() ? [cand.ref] : [])])].filter(x => typeof x === 'string' && x.trim()).slice(-20), aliases: [],
        firstSeen: at, lastSeen: at, seenCount: 1, runIds: [runId], evidence: [],
        baseScore: score, scores: cand.scores || {}, reason: cand.reason || '',
        scoreHistory: [{ run: runId, at, score }], status: 'open', statusAt: null, note: '',
        missedRuns: 0, rank: null, prevRank: null, bestRank: null, tier: null,
        movement: null, delta: null, score: 0, data: cand.data || {}
      };
      item.runIds = tail(item.runIds, config.maxHistory);
      item.scoreHistory = tail(item.scoreHistory, config.maxHistory);
      result.items[id] = item;
      runState.set(id, { preBase: null, high: score });
      added++;
    } else {
      merged++;
      item.lastSeen = at;
      item.missedRuns = 0;
      let state = runState.get(id);
      if (!state) {
        const alreadySeen = item.runIds.includes(runId);
        const history = item.scoreHistory.find(entry => entry.run === runId);
        let preBase = item.baseScore;
        if (alreadySeen && history) {
          preBase = item.seenCount === 1 ? null : config.blendNew < 1
            ? (item.baseScore - config.blendNew * history.score) / (1 - config.blendNew) : null;
        }
        state = { preBase, high: alreadySeen && history ? history.score : -Infinity };
        runState.set(id, state);
        if (!alreadySeen) {
          item.seenCount++;
          item.runIds = tail([...item.runIds, runId], config.maxHistory);
          item.scoreHistory.push({ run: runId, at, score });
        }
      }
      if (score > state.high) {
        state.high = score;
        item.baseScore = state.preBase === null ? score : round1(config.blendNew * score + (1 - config.blendNew) * state.preBase);
        const entry = item.scoreHistory.find(row => row.run === runId);
        if (entry) entry.score = score;
      }
      item.scoreHistory = tail(item.scoreHistory, config.maxHistory);
      if (normalizeText(title) !== normalizeText(item.title) && !item.aliases.some(alias => normalizeText(alias) === normalizeText(title))) {
        item.aliases = tail([...item.aliases, title], 10);
      }
      for (const field of ['summary', 'category', 'reason']) {
        if (cand[field]) item[field] = cand[field];
      }
      if (cand.scores && Object.keys(cand.scores).length) item.scores = cand.scores;
      if (typeof cand.ref === 'string' && cand.ref.trim() && !item.refs.includes(cand.ref)) {
        item.refs = tail([...item.refs, cand.ref], 20);
      }
      for (const ref of Array.isArray(cand.refs) ? cand.refs : []) if (typeof ref === 'string' && ref.trim() && !item.refs.includes(ref)) item.refs = tail([...item.refs, ref], 20);
      item.data = Object.assign({}, item.data, cand.data);
    }
    matched.add(id);
    addEvidence(item, cand.evidence, runId, at, config.maxEvidence);
  }
  for (const item of Object.values(result.items)) if (!matched.has(item.id)) item.missedRuns++;
  result.runs = tail([...result.runs, { id: runId, at, candidates: valid.length, added, merged }], config.maxRuns);
  result.updatedAt = at;
  result.lastRunId = runId;
  return rank(result, config);
}

function rank(store, opts) {
  const config = options(opts), result = structuredClone(store), ranked = [];
  for (const item of Object.values(result.items)) {
    item.score = effectiveScore(item, config);
    if (config.rankedStatuses.includes(item.status)) ranked.push(item);
    else {
      item.rank = null; item.tier = null; item.movement = null; item.delta = null;
    }
  }
  const sortScore = item => item.score + (item.prevRank !== null && item.prevRank <= config.incumbentTop ? config.hysteresis : 0);
  ranked.sort((a, b) => sortScore(b) - sortScore(a) || b.score - a.score ||
    b.seenCount - a.seenCount || compareText(a.firstSeen, b.firstSeen) || compareText(a.id, b.id));
  ranked.forEach((item, index) => {
    item.rank = index + 1;
    item.bestRank = Math.min(item.bestRank ?? item.rank, item.rank);
    const tier = config.tiers.find(row => item.rank <= row.maxRank);
    item.tier = tier ? tier.tier : null;
    item.movement = item.runIds.length === 1 && item.runIds[0] === result.lastRunId ? 'new'
      : item.prevRank === null ? 'returned' : item.rank < item.prevRank ? 'up'
        : item.rank > item.prevRank ? 'down' : 'same';
    item.delta = item.prevRank === null ? null : item.prevRank - item.rank;
  });
  return result;
}

function setStatus(store, id, status, { at, note, opts } = {}) {
  if (!Object.hasOwn(store.items, id)) throw error('STANDINGS_UNKNOWN_ID', 'Unknown item id');
  if (!STATUSES.includes(status)) throw error('STANDINGS_BAD_STATUS', 'Unknown status');
  const result = structuredClone(store), item = result.items[id];
  item.status = status;
  item.statusAt = at || null;
  item.note = typeof note === 'string' ? note : '';
  return rank(result, opts);
}

/* Fold duplicate items into one. The kept item gains the others' sightings, evidence, refs and titles, their best
   score and best rank, and store.merges maps each folded id to it, so an old id still resolves (resolveId).
   mergeItem(kept, folded) lets a board combine its own data and status before the folded item is removed. */
function foldItems(store, keepId, dropIds, { at = null, opts, mergeItem } = {}) {
  const config = options(opts), result = structuredClone(store), keep = result.items[keepId];
  if (!keep) throw error('STANDINGS_UNKNOWN_ID', 'Unknown item id');
  const same = (a, b) => normalizeText(a) === normalizeText(b);
  const best = (a, b) => a == null ? b : b == null ? a : Math.min(a, b);
  result.merges = { ...(result.merges || {}) };
  for (const id of new Set(dropIds)) {
    if (id === keepId || !Object.hasOwn(result.items, id)) continue;
    const drop = result.items[id];
    if (typeof mergeItem === 'function') mergeItem(keep, drop);
    for (const entry of drop.evidence) if (!keep.evidence.some(old => same(old.text, entry.text))) keep.evidence.push(entry);
    keep.evidence = tail(keep.evidence.sort((a, b) => compareText(a.at || '', b.at || '')), config.maxEvidence);
    keep.refs = tail([...new Set([...keep.refs, ...drop.refs])], 20);
    for (const title of [drop.title, ...drop.aliases]) {
      if (!same(title, keep.title) && !keep.aliases.some(alias => same(alias, title))) keep.aliases.push(title);
    }
    keep.aliases = tail(keep.aliases, 10);
    keep.seenCount += drop.seenCount - drop.runIds.filter(run => keep.runIds.includes(run)).length;
    keep.runIds = tail([...new Set([...keep.runIds, ...drop.runIds])].sort(compareText), config.maxHistory);
    for (const entry of drop.scoreHistory) {
      const old = keep.scoreHistory.find(row => row.run === entry.run);
      if (!old) keep.scoreHistory.push({ ...entry });
      else if (entry.score > old.score) old.score = entry.score;
    }
    keep.scoreHistory = tail(keep.scoreHistory.sort((a, b) => compareText(a.at || '', b.at || '')), config.maxHistory);
    if (drop.baseScore > keep.baseScore) {
      keep.baseScore = drop.baseScore;
      keep.scores = drop.scores;
      if (drop.reason) keep.reason = drop.reason;
    }
    if (compareText(drop.firstSeen, keep.firstSeen) < 0) keep.firstSeen = drop.firstSeen;
    if (compareText(drop.lastSeen, keep.lastSeen) > 0) keep.lastSeen = drop.lastSeen;
    keep.missedRuns = Math.min(keep.missedRuns, drop.missedRuns);
    keep.bestRank = best(keep.bestRank, drop.bestRank);
    keep.prevRank = best(keep.prevRank, drop.prevRank);
    keep.mergedFrom = [...(keep.mergedFrom || []), ...(drop.mergedFrom || []),
      { id, key: drop.key, title: drop.title, status: drop.status, at }];
    for (const [from, to] of Object.entries(result.merges)) if (to === id) result.merges[from] = keepId;
    result.merges[id] = keepId;
    delete result.items[id];
  }
  return rank(result, config);
}

function resolveId(store, id) {
  let current = id;
  for (let hops = 0; hops < 20 && !Object.hasOwn(store.items, current) && Object.hasOwn(store.merges || {}, current); hops++) {
    current = store.merges[current];
  }
  return Object.hasOwn(store.items, current) ? current : null;
}

/* Replace judged base scores and re-rank without creating a run or sighting. */
function rerank(store, updates = [], { opts } = {}) {
  const result = structuredClone(store);
  for (const update of updates) {
    const item = result.items[update.id];
    if (!item) continue;
    if (Number.isFinite(update.score)) item.baseScore = clamp(update.score);
    if (update.scores && typeof update.scores === 'object') item.scores = structuredClone(update.scores);
    if (typeof update.reason === 'string') item.reason = update.reason;
    if (update.data && typeof update.data === 'object') item.data = Object.assign({}, item.data, structuredClone(update.data));
  }
  return rank(result, opts);
}

function view(store, { query = '', status = 'all', limit = 500, offset = 0, opts } = {}) {
  const config = options(opts), counts = { open: 0, approved: 0, done: 0, trashed: 0, total: 0 };
  const terms = normalizeText(query).split(' ').filter(Boolean);
  const all = Object.values(store.items);
  for (const item of all) { counts[item.status]++; counts.total++; }
  const filtered = all.filter(item => {
    if (status !== 'all' && (status === 'ranked' ? !config.rankedStatuses.includes(item.status) : item.status !== status)) return false;
    const text = normalizeText([item.title, item.summary, ...item.aliases, item.category, item.reason].join(' '));
    return terms.every(term => text.includes(term));
  });
  const tiers = config.tiers.map(({ tier }) => ({ tier, count: filtered.filter(item => item.rank !== null && item.tier === tier).length }));
  filtered.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return compareText(b.statusAt || '', a.statusAt || '') || compareText(b.lastSeen, a.lastSeen) || compareText(a.id, b.id);
  });
  const fields = ['id', 'rank', 'prevRank', 'delta', 'bestRank', 'tier', 'movement', 'title', 'summary',
    'category', 'reason', 'score', 'baseScore', 'seenCount', 'firstSeen', 'lastSeen', 'missedRuns',
    'status', 'statusAt', 'note', 'aliases', 'refs', 'evidence', 'data'];
  const items = filtered.slice(offset, offset + limit).map(item => {
    const copy = {};
    for (const field of fields) copy[field] = field === 'evidence' ? item.evidence.slice(-3) : item[field];
    return structuredClone(copy);
  });
  return { board: store.board, updatedAt: store.updatedAt, lastRunId: store.lastRunId,
    runs: structuredClone(store.runs.slice(-10).reverse()), counts, tiers, total: filtered.length, items };
}

function load(file, board) {
  let contents;
  try { contents = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return emptyStore(board); throw err; }
  let parsed;
  try { parsed = JSON.parse(contents); }
  catch { throw error('STANDINGS_CORRUPT', 'Invalid standings file'); }
  if (!parsed || typeof parsed !== 'object' || !parsed.items || typeof parsed.items !== 'object' || Array.isArray(parsed.items)) {
    throw error('STANDINGS_CORRUPT', 'Invalid standings items');
  }
  if (parsed.runs !== undefined && !Array.isArray(parsed.runs)) throw error('STANDINGS_CORRUPT', 'Invalid standings runs');
  return { ...emptyStore(board), ...parsed };
}

function save(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let old;
  try { old = fs.readFileSync(file, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (old !== undefined) {
    let parsed;
    try { parsed = JSON.parse(old); } catch { parsed = null; }
    // A fold may shrink the store by exactly the items it recorded in merges; any other shrink is refused.
    if (parsed && parsed.items && typeof parsed.items === 'object') {
      const shrink = Object.keys(parsed.items).length - Object.keys(store.items).length;
      const folded = Object.keys(store.merges || {}).length - Object.keys(parsed.merges || {}).length;
      if (shrink > Math.max(0, folded)) throw error('STANDINGS_SHRINK', 'Refusing to shrink standings');
    }
  }
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(store, null, 1) + '\n');
  fs.renameSync(temp, file);
}

module.exports = { DEFAULTS, STATUSES, normalizeText, tokens, similarity, itemId, emptyStore,
  findMatch, effectiveScore, mergeRun, rank, rerank, foldItems, resolveId, setStatus, view, load, save };
