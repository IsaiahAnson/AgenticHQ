'use strict';

const standings = require('./standings.cjs');

function textKey(text) {
  return standings.normalizeText(String(text ?? '').replace(/^\s*-\s+/, ''));
}

function duplicateReport(items, { textOf = item => item.title } = {}) {
  const keys = new Map();
  items.forEach((item, index) => {
    const key = textKey(textOf(item));
    if (!key) return;
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(item.id ?? item.key ?? index);
  });
  const groups = [...keys].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }));
  return {
    total: items.length, unique: keys.size, duplicateTexts: groups.length,
    extraCopies: groups.reduce((sum, group) => sum + group.ids.length - 1, 0), groups
  };
}

function nearDuplicatePairs(items, { textOf = item => item.title, threshold = 0.8 } = {}) {
  const keys = items.map(item => textKey(textOf(item)));
  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    if (!keys[i]) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (!keys[j] || keys[i] === keys[j]) continue;
      const similarity = standings.similarity(keys[i], keys[j]);
      if (similarity >= threshold) pairs.push({
        a: items[i].id ?? items[i].key ?? i, b: items[j].id ?? items[j].key ?? j, similarity
      });
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

// The daily repeat check's alert (tools/ranked-dupes.mjs --alert, the Agentic HQ Repeat Check routine). Exact
// repeats push; look-alike pairs and views it couldn't read wait for the 8 PM digest (low). It names views and
// counts only and reads no item text, so a hidden view's text can't reach a push.
function viewName(endpoint) {
  const url = new URL(endpoint, 'http://hq');
  const board = url.pathname.match(/^\/api\/standings\/([a-z0-9-]+)/);   /* an add-on's board: /api/standings/<board> */
  const area = board ? board[1][0].toUpperCase() + board[1].slice(1) : url.pathname.includes('radar') ? 'Radar' : 'Learned';
  return `${area} ${url.searchParams.get('status') || 'widget'}`;
}
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function repeatAlert(rows) {
  const flagged = rows.filter(row => !row.ok || row.duplicateTexts > 0 || row.nearPairs > 0);
  if (!flagged.length) return null;
  const areas = list => [...new Set(list.map(row => viewName(row.endpoint).split(' ')[0]))].join(', ');
  const repeated = flagged.filter(row => row.ok && row.duplicateTexts > 0), near = flagged.filter(row => row.ok && row.nearPairs > 0);
  const lines = flagged.map(row => `${viewName(row.endpoint)}: ${row.ok
    ? [row.extraCopies > 0 && count(row.extraCopies, 'extra copy', 'extra copies'), row.nearPairs > 0 && count(row.nearPairs, 'look-alike pair', 'look-alike pairs')].filter(Boolean).join(', ')
    : `couldn't read (${String(row.error || 'no reason given').slice(0, 60)})`}`);
  const title = repeated.length ? `HQ repeats are back: ${areas(repeated)}`
    : near.length ? `HQ look-alike items: ${areas(near)}` : `HQ repeat check couldn't read ${count(flagged.length, 'view', 'views')}`;
  return { priority: repeated.length ? 'normal' : 'low', title, text: `${lines.join('; ')}. Run node tools/ranked-dupes.mjs --show-text to list them.` };
}

module.exports = { textKey, duplicateReport, nearDuplicatePairs, repeatAlert };
