'use strict';
// AI Radar sources: fetch, parse, normalize and merge candidate items (tools/ai-radar.mjs collect stage).
//   collectSources(config, ctx) -> { items, sources }   each source isolated: timeout, failure recorded, run continues
//   enrichGithub(items, ctx, config)                     GraphQL batches for the top candidates (stars, commits, releases, README)
// Parsers are pure and fixture-tested; network goes through ctx.fetchText / ctx.gh so tests never touch it.
// Item: { key, id, title, url, kind, sources:[{id,url,signal}], signals:{...}, text, date }.

const crypto = require('crypto');
const { spawn } = require('child_process');

const GH_RESERVED = new Set(['orgs', 'topics', 'features', 'marketplace', 'sponsors', 'settings', 'apps', 'login', 'about', 'collections',
  'trending', 'explore', 'search', 'notifications', 'enterprise', 'pricing', 'readme', 'site', 'security', 'customer-stories', 'events', 'team']);
const TRACKING = /^(utm_|ref$|ref_src$|source$|via$|fbclid$|gclid$|mc_)/i;
const KIND_RANK = { release: 6, repo: 5, tool: 4, model: 3, technique: 2, article: 1 };
const KINDS = Object.keys(KIND_RANK);

// ---------- urls, keys, ids ----------
function normalizeUrl(input) {
  let u; try { u = new URL(String(input || '').trim()); } catch (_) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^old\./, '');
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const search = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let pathname = u.pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const paper = pathname.match(/^\/(?:abs|pdf|html)\/((?:[a-z][a-z.-]*\/\d{7}|\d{4}\.\d{4,5}))(?:v\d+)?(?:\.pdf)?$/i);
    if (paper) return `https://arxiv.org/abs/${paper[1]}`;
  }
  return `https://${host}${pathname === '/' ? '' : pathname}${search}`;
}

function changelogPath(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  const last = parts[parts.length - 1];
  const version = /^v?\d+(?:[.-]\d+){1,3}$/i.test(last) &&
    parts.some(p => /^(?:changelog|release-notes|releases|whats-new|updates)$/i.test(p)) ? last.replace(/^v/i, '').replace(/-/g, '.') : '';
  if (version) parts.pop();
  else parts[parts.length - 1] = last.replace(/^((?:changelog|release-notes))(?:\.md(?:\.txt)?|\.txt)$/i, '$1');
  u.pathname = parts.join('/') || '/';
  return { keyUrl: u.origin + (u.pathname === '/' ? '' : u.pathname) + u.search, version };
}

function ghRepoOf(url) {
  const n = normalizeUrl(url); if (!n) return null;
  const u = new URL(n);
  if (u.hostname !== 'github.com') return null;
  const [owner, repo] = u.pathname.split('/').filter(Boolean);
  if (!owner || !repo || GH_RESERVED.has(owner.toLowerCase())) return null;
  return `${owner}/${repo.replace(/\.git$/i, '')}`;
}

function keyFor(url) {
  const n = normalizeUrl(url); if (!n) return null;
  const repo = ghRepoOf(n);
  if (repo) return 'gh:' + repo.toLowerCase();
  const u = new URL(n);
  if (u.hostname === 'npmjs.com') {
    const m = u.pathname.match(/^\/package\/((?:@[^/]+\/)?[^/]+)/);
    if (m) return 'pkg:npm/' + decodeURIComponent(m[1]).toLowerCase();
  }
  return 'url:' + changelogPath(n).keyUrl;
}

// Finding id: ^[a-z0-9][a-z0-9-]{0,80}$ (the page's route validation).
function idFor(key) {
  const base = String(key || '').toLowerCase().replace(/^url:https?:\/\//, 'url-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  if (base.length <= 81) return base;
  const hash = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 6);
  return base.slice(0, 74).replace(/-+$/, '') + '-' + hash;
}

function releaseTagOf(url) {
  const m = String(url || '').match(/github\.com\/[^/]+\/[^/]+\/releases\/tag\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]) : '';
}

// ---------- text helpers ----------
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const stripHtml = s => decodeEntities(String(s || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const time = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// ---------- items ----------
function makeItem({ url, title, kind, source, signals = {}, text = '', date = null }) {
  const key = keyFor(url); if (!key) return null;
  const repo = ghRepoOf(url);
  const tag = signals.releaseTag || releaseTagOf(url);
  const version = changelogPath(normalizeUrl(url)).version;
  const k = KINDS.includes(kind) ? kind : (tag ? 'release' : repo ? 'repo' : 'article');
  return {
    key, id: idFor(key), title: clip(decodeEntities(title || repo || url), 200),
    url: repo ? `https://github.com/${repo}` : normalizeUrl(url), kind: tag ? 'release' : k,
    sources: [{ id: source.id, url: source.url || url, signal: source.signal || '' }],
    signals: { ...signals, ...(tag ? { releaseTag: tag } : {}), ...(version ? { version } : {}) }, text: clip(text, 600), date
  };
}

function compareVersions(a, b) {
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] || 0n, y = right[i] || 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function mergeItems(items) {
  const map = new Map();
  for (const it of items.filter(Boolean)) {
    const cur = map.get(it.key);
    if (!cur) { map.set(it.key, { ...it, sources: [...it.sources], signals: { ...it.signals } }); continue; }
    for (const s of it.sources) if (!cur.sources.some(x => x.id === s.id && x.url === s.url) && cur.sources.filter(x => x.id === s.id).length < 2) cur.sources.push(s);
    const bothVersions = cur.signals.version && it.signals?.version &&
      /^\d+(?:\.\d+){1,3}$/.test(cur.signals.version) && /^\d+(?:\.\d+){1,3}$/.test(it.signals.version);
    if (bothVersions && compareVersions(it.signals.version, cur.signals.version) > 0) {
      cur.signals.version = it.signals.version;
      cur.url = it.url;
      cur.title = it.title;
    }
    for (const [k, v] of Object.entries(it.signals || {})) {
      if (typeof v === 'number') cur.signals[k] = Math.max(Number(cur.signals[k]) || 0, v);
      else if (v && !cur.signals[k]) cur.signals[k] = v;
    }
    if (KIND_RANK[it.kind] > KIND_RANK[cur.kind]) cur.kind = it.kind;
    if ((it.text || '').length > (cur.text || '').length) cur.text = it.text;
    if (it.date && (!cur.date || time(it.date) > time(cur.date))) cur.date = it.date;
    if (!bothVersions && /^[^/\s]+\/[^/\s]+$/.test(cur.title) && !/^[^/\s]+\/[^/\s]+$/.test(it.title)) cur.title = it.title;
  }
  for (const it of map.values()) it.signals.sourceCount = new Set(it.sources.map(s => s.id)).size;
  return [...map.values()];
}

// New = never seen, or a new release tag, or a large star jump since it was last seen.
function markNew(items, seen = {}, opts = {}) {
  const factor = opts.starJumpFactor || 2, min = opts.starJumpMin || 500;
  for (const it of items) {
    const s = seen[it.key];
    it.lastVersion = s && s.lastVersion || null;
    const stars = Number(it.signals.stars) || 0, last = Number(s && s.lastStars) || 0;
    if (!s) { it.isNew = true; it.newReason = 'first'; }
    else if (it.signals.releaseTag && it.signals.releaseTag !== s.lastVersion) { it.isNew = true; it.newReason = 'release'; }
    else if (last && stars >= last * factor && stars - last >= min) { it.isNew = true; it.newReason = 'stars'; }
    else { it.isNew = false; it.newReason = null; }
  }
  return items;
}

function updateSeen(seen = {}, items, nowIso, skipKeys = new Set()) {
  const out = { ...seen };
  for (const it of items) {
    if (skipKeys.has(it.key)) continue;
    const s = out[it.key] || {};
    out[it.key] = {
      firstSeen: s.firstSeen || nowIso, lastSeen: nowIso,
      lastVersion: it.signals.releaseTag || s.lastVersion || null,
      lastStars: Number(it.signals.stars) || s.lastStars || null
    };
  }
  return out;
}

// ---------- parsers (pure) ----------
function tagText(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i'));
    if (m) return m[1];
  }
  return '';
}

function parseFeed(xml) {
  const src = String(xml || '');
  const atom = /<entry[\s>]/i.test(src);
  const blocks = src.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  return blocks.map(b => {
    let link = '';
    if (atom) {
      const links = [...b.matchAll(/<link\b([^>]*)\/?>/gi)].map(m => m[1]);
      const pick = links.find(a => /rel=["']alternate["']/i.test(a)) || links.find(a => !/rel=/i.test(a)) || links[0] || '';
      link = decodeEntities((pick.match(/href=["']([^"']+)["']/i) || [])[1] || '');
    } else link = decodeEntities(stripHtml(tagText(b, ['link'])) || tagText(b, ['guid']));
    const rawContent = tagText(b, ['content', 'content:encoded', 'summary', 'description']);
    return {
      title: stripHtml(tagText(b, ['title'])),
      link: link.trim(),
      id: stripHtml(tagText(b, ['id', 'guid'])),
      date: stripHtml(tagText(b, ['published', 'updated', 'pubDate', 'dc:date'])) || null,
      html: decodeEntities(rawContent),
      summary: clip(stripHtml(decodeEntities(rawContent)), 600)
    };
  });
}

function parseReleasesAtom(xml, repo, sinceMs) {
  const entries = parseFeed(xml).filter(e => (time(e.date) || 0) >= sinceMs);
  if (!entries.length) return [];
  const e = entries.sort((a, b) => time(b.date) - time(a.date))[0];
  const tag = releaseTagOf(e.link) || (e.id.match(/\/([^/]+)$/) || [])[1] || e.title;
  return [makeItem({
    url: `https://github.com/${repo}`, title: `${repo} ${tag}`, kind: 'release', date: e.date, text: e.summary,
    source: { id: 'github-releases', url: e.link || `https://github.com/${repo}/releases`, signal: `release ${tag}` },
    signals: { releaseTag: tag, releaseAt: e.date, watchlist: true, releasesInWindow: entries.length }
  })];
}

function parseFeedItems(xml, feed, sinceMs) {
  return parseFeed(xml).filter(e => e.link && (time(e.date) || 0) >= sinceMs).map(e => makeItem({
    url: e.link, title: e.title, kind: feed.kind, date: e.date, text: e.summary,
    source: { id: feed.id, url: e.link, signal: feed.id }
  }));
}

function parseHn(json, sourceId, minPoints) {
  return ((json && json.hits) || []).filter(h => (Number(h.points) || 0) >= minPoints && (h.title || h.story_title)).map(h => {
    const hnUrl = `https://news.ycombinator.com/item?id=${h.objectID}`;
    return makeItem({
      url: h.url || hnUrl, title: h.title || h.story_title, date: h.created_at, text: stripHtml(h.story_text || ''),
      source: { id: sourceId, url: hnUrl, signal: `${h.points} points, ${h.num_comments || 0} comments` },
      signals: { hnPoints: Number(h.points) || 0, comments: Number(h.num_comments) || 0 }
    });
  });
}

function parseLobsters(json, minScore, sinceMs) {
  return (Array.isArray(json) ? json : []).filter(s => (Number(s.score) || 0) >= minScore && (time(s.created_at) || 0) >= sinceMs).map(s => makeItem({
    url: s.url || s.short_id_url, title: s.title, date: s.created_at, text: s.description_plain || '',
    source: { id: 'lobsters', url: s.short_id_url || s.comments_url, signal: `${s.score} points` },
    signals: { lobstersScore: Number(s.score) || 0 }
  }));
}

const REDDIT_HOSTS = /(^|\.)(reddit\.com|redd\.it|redditmedia\.com|imgur\.com)$/i;
function parseReddit(xml, sub, perSub) {
  return parseFeed(xml).slice(0, perSub).map((e, i) => {
    const links = [...String(e.html).matchAll(/href=["']([^"']+)["'][^>]*>\s*\[link\]/gi)].map(m => decodeEntities(m[1]));
    let url = e.link;
    try { if (links[0] && !REDDIT_HOSTS.test(new URL(links[0]).hostname)) url = links[0]; } catch (_) { }
    return makeItem({
      url, title: e.title, date: e.date, text: '',
      source: { id: 'reddit', url: e.link, signal: `#${i + 1} today on r/${sub}` },
      signals: { redditRank: i + 1 }
    });
  });
}

function parseMcpRegistry(json, sinceMs) {
  const out = [];
  for (const row of (json && json.servers) || []) {
    const s = row.server || {}, meta = (row._meta && row._meta['io.modelcontextprotocol.registry/official']) || {};
    if (meta.isLatest === false || (time(meta.publishedAt) || 0) < sinceMs) continue;
    const repoUrl = s.repository && s.repository.url;
    const url = repoUrl || s.websiteUrl; if (!url) continue;
    out.push(makeItem({
      url, title: s.title || s.name, kind: 'tool', date: meta.publishedAt, text: s.description || '',
      source: { id: 'mcp-registry', url: `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(s.name || '')}`, signal: `MCP registry ${s.name} v${s.version || '?'}` },
      signals: { mcpName: s.name || '', version: s.version || '' }
    }));
  }
  return out;
}

function parseGhSearch(json) {
  return ((json && json.items) || []).map(r => makeItem({
    url: r.html_url, title: r.full_name, kind: 'repo', date: r.created_at, text: r.description || '',
    source: { id: 'github-search', url: r.html_url, signal: `${r.stargazers_count} stars` },
    signals: { stars: r.stargazers_count || 0, createdAt: r.created_at, pushedAt: r.pushed_at, license: (r.license && r.license.spdx_id) || '', archived: !!r.archived }
  }));
}

// awesome-mcp-servers: a newly added list entry (an added "- [name](https://github.com/o/r)" line) is the signal.
function parseAwesomeDiff(compare, repo) {
  const added = [], removed = new Set(), seen = new Set();
  const ENTRY = /\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)(.*)$/;
  for (const f of (compare && compare.files) || []) {
    for (const line of String(f.patch || '').split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      const m = line.slice(1).match(ENTRY);
      if (!m) continue;
      if (line.startsWith('-')) removed.add(m[2]);
      else if (line.startsWith('+')) added.push(m);
    }
  }
  const out = [];
  for (const m of added) {
    if (removed.has(m[2]) || seen.has(m[2])) continue;
    seen.add(m[2]);
    const rest = m[3], dash = rest.indexOf(' - ');
    out.push(makeItem({
      url: m[2], title: m[1], kind: 'tool', text: (dash >= 0 ? rest.slice(dash + 3) : rest.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')).trim(),
      source: { id: 'awesome-mcp', url: `https://github.com/${repo}/commits/main`, signal: 'newly added to awesome-mcp-servers' }
    }));
  }
  return out.length > 50 ? [] : out;   /* more than 50 "new" entries means a bulk rewrite, not curation */
}

// ---------- network (injectable) ----------
async function fetchText(url, { timeoutMs = 20000, ua = 'AgenticHQ-AIRadar/1.0', accept = '*/*', method = 'GET' } = {}) {
  const res = await fetch(url, { method, redirect: 'follow', headers: { 'user-agent': ua, accept }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 120)}`);
  return method === 'HEAD' ? '' : res.text();
}

// gh with your existing login. Never reads or prints the token; stdin carries GraphQL bodies.
function gh(args, { input = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`gh timed out: ${args[0]} ${args[1] || ''}`)); }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      let json = null; try { json = out.trim() ? JSON.parse(out) : null; } catch (_) { }
      if (code === 0) return resolve(json);
      const e = new Error(`gh ${args[0]} ${args[1] || ''} exited ${code}: ${err.trim().split('\n')[0].slice(0, 160)}`);
      e.json = json; reject(e);
    });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

function withTimeout(promise, ms, label) {
  let t; const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

const dayStamp = ms => new Date(ms).toISOString().slice(0, 10);

function sourceTasks(cfg, ctx) {
  const now = ctx.now || Date.now(), sinceMs = now - (cfg.windowHours || 72) * 3600e3;
  const get = (url, accept) => ctx.fetchText(url, { timeoutMs: cfg.sourceTimeoutMs, ua: cfg.userAgent, accept });
  const getJson = async url => JSON.parse(await get(url, 'application/json'));
  const g = cfg.github || {};
  const tasks = [];
  tasks.push({ id: 'github-search', run: async () => {
    const since = dayStamp(now - 3 * 864e5), since30 = dayStamp(now - 30 * 864e5);
    const results = await Promise.allSettled((g.queries || []).map(q => ctx.gh(['api', '-X', 'GET', 'search/repositories',
      '-f', 'q=' + q.replace(/\{since\}/g, since).replace(/\{since30\}/g, since30).replace(/\{minStars\}/g, String(g.minStars || 20)),
      '-f', 'sort=stars', '-f', 'order=desc', '-f', 'per_page=30'])));
    const ok = results.filter(r => r.status === 'fulfilled');
    if (!ok.length && results.length) throw results[0].reason;
    return ok.flatMap(r => parseGhSearch(r.value));
  } });
  tasks.push({ id: 'github-releases', run: async () => {
    const results = await Promise.allSettled((g.watchlist || []).map(async repo => parseReleasesAtom(await get(`https://github.com/${repo}/releases.atom`, 'application/atom+xml'), repo, sinceMs)));
    const ok = results.filter(r => r.status === 'fulfilled');
    if (!ok.length && results.length) throw results[0].reason;
    return ok.flatMap(r => r.value);
  } });
  const hn = cfg.hn || {}, since = Math.floor(sinceMs / 1000);
  const hnQuery = async (tag, q, min) => getJson(`https://hn.algolia.com/api/v1/search_by_date?tags=${tag}&query=${encodeURIComponent(q)}&numericFilters=${encodeURIComponent(`created_at_i>${since},points>=${min}`)}&hitsPerPage=40`);
  tasks.push({ id: 'hn', run: async () => (await Promise.all((hn.queries || []).map(q => hnQuery('story', q, hn.minPoints || 30)))).flatMap(j => parseHn(j, 'hn', hn.minPoints || 30)) });
  tasks.push({ id: 'show-hn', run: async () => (await Promise.all((hn.showQueries || []).map(q => hnQuery('show_hn', q, hn.showMinPoints || 8)))).flatMap(j => parseHn(j, 'show-hn', hn.showMinPoints || 8)) });
  const lob = cfg.lobsters || {};
  tasks.push({ id: 'lobsters', run: async () => (await Promise.all((lob.tags || ['ai']).map(t => getJson(`https://lobste.rs/t/${t}.json`)))).flatMap(j => parseLobsters(j, lob.minScore || 5, sinceMs)) });
  const rd = cfg.reddit || {};
  tasks.push({ id: 'reddit', run: async () => {   /* one sub at a time: parallel requests get 429 */
    const out = []; let firstError = null;
    for (const s of rd.subs || []) {
      try { out.push(...parseReddit(await get(`https://www.reddit.com/r/${s}/top/.rss?t=day`, 'application/atom+xml'), s, rd.perSub || 10)); }
      catch (e) { firstError = firstError || e; }
      await new Promise(r => setTimeout(r, ctx.redditDelayMs ?? 1500));
    }
    if (!out.length && firstError) throw firstError;
    return out;
  } });
  const mcp = cfg.mcpRegistry || {};
  tasks.push({ id: 'mcp-registry', run: async () => {
    const out = []; let cursor = null;
    for (let page = 0; page < (mcp.maxPages || 4); page++) {
      const url = `${mcp.url}?updated_since=${encodeURIComponent(new Date(sinceMs).toISOString())}&limit=100${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
      const j = await getJson(url);
      out.push(...parseMcpRegistry(j, sinceMs));
      cursor = j.metadata && j.metadata.nextCursor; if (!cursor) break;
    }
    return out;
  } });
  const aw = cfg.awesome || {};
  if (aw.repo) tasks.push({ id: 'awesome-mcp', run: async () => {
    const entries = parseFeed(await get(`https://github.com/${aw.repo}/commits/main.atom`, 'application/atom+xml'));
    const shaOf = e => (e.id.match(/Commit\/([0-9a-f]{7,40})/i) || e.link.match(/commit\/([0-9a-f]{7,40})/i) || [])[1];
    const inWindow = entries.filter(e => (time(e.date) || 0) >= sinceMs);
    if (!inWindow.length) return [];
    const head = shaOf(inWindow[0]), older = entries[inWindow.length], base = older ? shaOf(older) : shaOf(inWindow[inWindow.length - 1]) + '^';
    if (!head || !base) return [];
    return parseAwesomeDiff(await ctx.gh(['api', `repos/${aw.repo}/compare/${base}...${head}`]), aw.repo);
  } });
  for (const feed of cfg.feeds || []) tasks.push({ id: feed.id, run: async () => parseFeedItems(await get(feed.url, 'application/rss+xml, application/atom+xml, application/xml'), feed, sinceMs) });
  return tasks;
}

async function collectSources(cfg, ctx = {}) {
  ctx = { fetchText, gh, ...ctx };
  const tasks = sourceTasks(cfg, ctx), perSource = (cfg.limits && cfg.limits.perSource) || 60;
  const sources = [], all = [];
  await Promise.all(tasks.map(async t => {
    const t0 = Date.now();
    try {
      const items = (await withTimeout(t.run(), cfg.sourceTimeoutMs || 20000, t.id)).filter(Boolean);
      const capped = t.id === 'mcp-registry' ? items.sort((a, b) => (b.key.startsWith('gh:') - a.key.startsWith('gh:'))).slice(0, perSource * 2) : items.slice(0, perSource * 3);
      all.push(...capped);
      sources.push({ id: t.id, ok: true, items: capped.length, ms: Date.now() - t0, error: null });
    } catch (e) {
      sources.push({ id: t.id, ok: false, items: 0, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 200) });
    }
  }));
  sources.sort((a, b) => tasks.findIndex(t => t.id === a.id) - tasks.findIndex(t => t.id === b.id));
  return { items: mergeItems(all), sources };
}

// ---------- enrichment (GraphQL, batched) ----------
const GQL_FIELDS = `nameWithOwner stargazerCount createdAt pushedAt isArchived isFork diskUsage description homepageUrl
  licenseInfo{spdxId} repositoryTopics(first:10){nodes{topic{name}}} openIssues: issues(states:OPEN){totalCount} closedIssues: issues(states:CLOSED){totalCount}
  releases(first:1, orderBy:{field:CREATED_AT, direction:DESC}){totalCount nodes{tagName publishedAt url description}}
  readme: object(expression:"HEAD:README.md"){... on Blob{byteSize text}} readmeLower: object(expression:"HEAD:readme.md"){... on Blob{byteSize text}}
  defaultBranchRef{ target{ ... on Commit{ oid committedDate c30: history(since:$since30){totalCount} c90: history(since:$since90, first:100){totalCount nodes{author{user{login}}}} } } }`;

function applyRepo(it, r, cfg, now) {
  if (!r) { it.signals.missing = true; return; }
  const lim = cfg.limits || {};
  const rel = (r.releases && r.releases.nodes && r.releases.nodes[0]) || null;
  const head = (r.defaultBranchRef && r.defaultBranchRef.target) || {};
  const readme = r.readme || r.readmeLower || null;
  const logins = new Set(((head.c90 && head.c90.nodes) || []).map(n => n.author && n.author.user && n.author.user.login).filter(Boolean));
  const ageDays = Math.max(1, (now - (time(r.createdAt) || now)) / 864e5);
  Object.assign(it.signals, {
    stars: r.stargazerCount, starsPerDay: Math.round((r.stargazerCount / ageDays) * 10) / 10, createdAt: r.createdAt, pushedAt: r.pushedAt,
    license: (r.licenseInfo && r.licenseInfo.spdxId) || '', archived: !!r.isArchived, fork: !!r.isFork, diskKB: r.diskUsage || 0,
    topics: ((r.repositoryTopics && r.repositoryTopics.nodes) || []).map(n => n.topic.name),
    openIssues: (r.openIssues && r.openIssues.totalCount) || 0, closedIssues: (r.closedIssues && r.closedIssues.totalCount) || 0,
    releases: (r.releases && r.releases.totalCount) || 0, lastReleaseTag: rel ? rel.tagName : '', lastReleaseAt: rel ? rel.publishedAt : '',
    commits30: (head.c30 && head.c30.totalCount) || 0, commits90: (head.c90 && head.c90.totalCount) || 0, contributors90: logins.size,
    lastCommitAt: head.committedDate || '', sha: head.oid ? head.oid.slice(0, 12) : '', readmeBytes: readme ? readme.byteSize : 0, enriched: true
  });
  it.url = `https://github.com/${r.nameWithOwner}`;
  if (!it.title || it.title.toLowerCase() === r.nameWithOwner.toLowerCase()) it.title = r.nameWithOwner;
  if (r.description && !(it.text || '').includes(r.description)) it.text = clip([r.description, it.text].filter(Boolean).join(' — '), 600);
  it.readme = readme && readme.text ? clip(readme.text, lim.excerptChars || 3500) : '';
  it.releaseNotes = rel && rel.description ? clip(rel.description, lim.releaseChars || 1800) : '';
}

async function enrichGithub(items, ctx = {}, cfg = {}) {
  ctx = { gh, ...ctx };
  const now = ctx.now || Date.now();
  const targets = items.filter(it => it.key.startsWith('gh:'));
  const vars = { since30: new Date(now - 30 * 864e5).toISOString(), since90: new Date(now - 90 * 864e5).toISOString() };
  let calls = 0, failed = 0;
  for (let i = 0; i < targets.length; i += 8) {
    const batch = targets.slice(i, i + 8);
    const body = batch.map((it, j) => {
      const [owner, name] = it.key.slice(3).split('/');
      return `r${j}: repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(name)}){ ${GQL_FIELDS} }`;
    }).join('\n');
    const query = `query($since30: GitTimestamp!, $since90: GitTimestamp!){ ${body} }`;
    let data = null; calls++;
    try { data = (await ctx.gh(['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query, variables: vars }), timeoutMs: 45000 })).data; }
    catch (e) { data = e.json && e.json.data; if (!data) failed++; }
    if (!data) continue;
    batch.forEach((it, j) => applyRepo(it, data[`r${j}`], cfg, now));
  }
  return { calls, failed, enriched: targets.filter(t => t.signals.enriched).length };
}

// A swept or cited link counts only when it answers 2xx/3xx.
async function checkUrl(url, ctx = {}) {
  const f = ctx.fetchText || fetchText;
  try { await f(url, { method: 'HEAD', timeoutMs: 10000 }); return true; }
  catch (_) { try { await f(url, { timeoutMs: 12000 }); return true; } catch (_) { return false; } }
}

module.exports = {
  normalizeUrl, keyFor, idFor, ghRepoOf, releaseTagOf, decodeEntities, stripHtml, clip,
  makeItem, mergeItems, markNew, updateSeen,
  parseFeed, parseReleasesAtom, parseFeedItems, parseHn, parseLobsters, parseReddit, parseMcpRegistry, parseGhSearch, parseAwesomeDiff,
  fetchText, gh, withTimeout, collectSources, enrichGithub, checkUrl, KINDS
};
