'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const S = require('../lib/radar-sources.cjs');

const FIX = path.join(__dirname, 'fixtures', 'radar');
const fx = name => fs.readFileSync(path.join(FIX, name), 'utf8');
const SINCE = Date.parse('2026-10-26T00:00:00Z');

test('normalizeUrl drops tracking params, www, trailing slashes and fragments', () => {
  assert.equal(S.normalizeUrl('http://www.Example.com/a/b/?utm_source=x&b=2&a=1#frag'), 'https://example.com/a/b?a=1&b=2');
  assert.equal(S.normalizeUrl('javascript:alert(1)'), null);
  assert.equal(S.normalizeUrl('not a url'), null);
});

test('keyFor makes canonical gh:, pkg: and url: keys', () => {
  assert.equal(S.keyFor('https://github.com/Acme/Agent-Tool/tree/main/src'), 'gh:acme/agent-tool');
  assert.equal(S.keyFor('https://github.com/acme/agent-tool.git'), 'gh:acme/agent-tool');
  assert.equal(S.keyFor('https://github.com/topics/mcp'), 'url:https://github.com/topics/mcp');
  assert.equal(S.keyFor('https://www.npmjs.com/package/@scope/pkg'), 'pkg:npm/@scope/pkg');
  assert.equal(S.keyFor('https://blog.example.org/post/'), 'url:https://blog.example.org/post');
});

test('idFor always matches the page route pattern', () => {
  const re = /^[a-z0-9][a-z0-9-]{0,80}$/;
  assert.equal(S.idFor('gh:acme/agent-tool'), 'gh-acme-agent-tool');
  const long = S.idFor('url:https://example.com/' + 'x'.repeat(300));
  assert.match(long, re);
  assert.notEqual(long, S.idFor('url:https://example.com/' + 'x'.repeat(299)));
  for (const k of ['url:https://例子.com/путь', 'pkg:npm/@scope/pkg', '']) assert.match(S.idFor(k), re);
});

test('parseReleasesAtom keeps the newest release in the window with its tag', () => {
  const [it] = S.parseReleasesAtom(fx('releases.atom'), 'tobi/qmd', SINCE);
  assert.equal(it.key, 'gh:tobi/qmd');
  assert.equal(it.kind, 'release');
  assert.equal(it.signals.releaseTag, 'v2.9.0');
  assert.equal(it.signals.watchlist, true);
  assert.match(it.text, /rerank mode/);
  assert.deepEqual(S.parseReleasesAtom(fx('releases.atom'), 'tobi/qmd', Date.parse('2026-10-30T00:00:00Z')), []);
});

test('parseReddit uses the outbound link, not the reddit post or an image host', () => {
  const items = S.parseReddit(fx('reddit.rss'), 'ClaudeAI', 10);
  assert.equal(items[0].key, 'gh:acme/agent-tool');
  assert.equal(items[0].signals.redditRank, 1);
  assert.equal(items[0].sources[0].url, 'https://www.reddit.com/r/ClaudeAI/comments/abc/agent_tool/');
  assert.equal(items[1].key, 'url:https://reddit.com/r/ClaudeAI/comments/def/meme');
  assert.equal(items[1].title, 'Meme & joke');
});

test('parseHn applies the points floor and falls back to the HN item url', () => {
  const items = S.parseHn(JSON.parse(fx('hn.json')), 'hn', 30);
  assert.equal(items.length, 2);
  assert.equal(items[0].signals.hnPoints, 312);
  assert.equal(items[1].key, 'url:https://news.ycombinator.com/item?id=1002');
});

test('parseLobsters, parseMcpRegistry, parseGhSearch and parseFeedItems normalize their shapes', () => {
  const lob = S.parseLobsters(JSON.parse(fx('lobsters.json')), 5, SINCE);
  assert.deepEqual(lob.map(i => i.key), ['url:https://blog.example.org/context-packing']);
  const mcp = S.parseMcpRegistry(JSON.parse(fx('mcp-registry.json')), SINCE);
  assert.deepEqual(mcp.map(i => i.key), ['gh:acme/agent-tool', 'url:https://hosted.example.ai']);
  assert.equal(mcp[0].kind, 'tool');
  const gh = S.parseGhSearch(JSON.parse(fx('gh-search.json')));
  assert.equal(gh[0].signals.stars, 540);
  assert.equal(gh[1].signals.license, '');
  const feed = S.parseFeedItems(fx('feed.rss'), { id: 'github-changelog', kind: 'release' }, SINCE);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].text, 'Copilot CLI now supports hooks & plugins.');
  assert.equal(feed[1].key, 'gh:vercel-labs/fx');
  assert.equal(feed[1].signals.releaseTag, 'v0.0.16');
});

test('parseAwesomeDiff keeps newly added entries and ignores moved ones', () => {
  const items = S.parseAwesomeDiff(JSON.parse(fx('compare.json')), 'punkpeye/awesome-mcp-servers');
  assert.deepEqual(items.map(i => i.key), ['gh:acme/agent-tool']);
  assert.equal(items[0].text, 'Worktree manager for agents');
});

test('mergeItems dedupes one repo seen on several sources and counts distinct sources', () => {
  const all = [
    ...S.parseHn(JSON.parse(fx('hn.json')), 'hn', 30),
    ...S.parseReddit(fx('reddit.rss'), 'ClaudeAI', 10),
    ...S.parseGhSearch(JSON.parse(fx('gh-search.json'))),
    ...S.parseMcpRegistry(JSON.parse(fx('mcp-registry.json')), SINCE)
  ];
  const merged = S.mergeItems(all);
  const tool = merged.find(i => i.key === 'gh:acme/agent-tool');
  assert.equal(merged.filter(i => i.key === 'gh:acme/agent-tool').length, 1);
  assert.equal(tool.signals.sourceCount, 4);
  assert.equal(tool.signals.stars, 540);
  assert.equal(tool.signals.hnPoints, 312);
  assert.equal(tool.kind, 'repo');
  assert.notEqual(tool.title, 'acme/agent-tool', 'a descriptive title beats owner/repo');
});

test('markNew: unseen, new release tag and large star jump come back; the rest stay seen', () => {
  const items = [
    { key: 'gh:a/new', signals: {} },
    { key: 'gh:a/same', signals: { releaseTag: 'v1', stars: 100 } },
    { key: 'gh:a/rel', signals: { releaseTag: 'v2' } },
    { key: 'gh:a/jump', signals: { stars: 3000 } },
    { key: 'gh:a/small', signals: { stars: 150 } }
  ];
  const seen = { 'gh:a/same': { lastVersion: 'v1', lastStars: 90 }, 'gh:a/rel': { lastVersion: 'v1' }, 'gh:a/jump': { lastStars: 1000 }, 'gh:a/small': { lastStars: 100 } };
  S.markNew(items, seen, { starJumpFactor: 2, starJumpMin: 500 });
  assert.deepEqual(items.map(i => i.newReason), ['first', null, 'release', 'stars', null]);
  const next = S.updateSeen(seen, items, '2026-10-29T12:00:00Z', new Set(['gh:a/new']));
  assert.equal(next['gh:a/new'], undefined, 'skipped keys stay unseen');
  assert.equal(next['gh:a/rel'].lastVersion, 'v2');
  assert.equal(next['gh:a/jump'].lastStars, 3000);
});

test('collectSources isolates a failing source and keeps the rest', async () => {
  const cfg = {
    windowHours: 72, sourceTimeoutMs: 2000, userAgent: 'test',
    github: { queries: ['topic:mcp created:>={since}'], watchlist: ['tobi/qmd'] },
    hn: { queries: ['agent'], minPoints: 30, showQueries: [] }, lobsters: { tags: ['ai'], minScore: 5 },
    reddit: { subs: ['ClaudeAI'], perSub: 10 }, mcpRegistry: { url: 'https://registry.test/v0.1/servers', maxPages: 1 },
    feeds: [{ id: 'broken-feed', url: 'https://broken.test/feed', kind: 'article' }]
  };
  const fetchText = async url => {
    if (url.includes('releases.atom')) return fx('releases.atom');
    if (url.includes('algolia')) return fx('hn.json');
    if (url.includes('lobste.rs')) return fx('lobsters.json');
    if (url.includes('reddit.com')) return fx('reddit.rss');
    if (url.includes('registry.test')) return fx('mcp-registry.json');
    throw new Error('HTTP 500 ' + url);
  };
  const gh = async args => { if (args.includes('search/repositories')) return JSON.parse(fx('gh-search.json')); throw new Error('unexpected gh call'); };
  const { items, sources } = await S.collectSources(cfg, { fetchText, gh, now: Date.parse('2026-10-29T20:00:00Z'), redditDelayMs: 0 });
  const byId = Object.fromEntries(sources.map(s => [s.id, s]));
  assert.equal(byId['broken-feed'].ok, false);
  assert.match(byId['broken-feed'].error, /HTTP 500/);
  assert.equal(byId['github-search'].ok, true);
  assert.equal(byId['github-releases'].items, 1);
  assert.ok(items.find(i => i.key === 'gh:acme/agent-tool').signals.sourceCount >= 3);
});

test('enrichGithub maps GraphQL fields into signals and excerpts', async () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  const items = [S.makeItem({ url: 'https://github.com/acme/agent-tool', title: 'acme/agent-tool', source: { id: 'github-search' } })];
  const gh = async (args, { input }) => {
    assert.match(JSON.parse(input).query, /r0: repository\(owner:"acme", name:"agent-tool"\)/);
    return { data: { r0: {
      nameWithOwner: 'Acme/agent-tool', stargazerCount: 540, createdAt: '2026-10-27T00:00:00Z', pushedAt: '2026-10-28T00:00:00Z', isArchived: false, isFork: false,
      diskUsage: 900, description: 'Worktrees for agents', licenseInfo: { spdxId: 'MIT' }, repositoryTopics: { nodes: [{ topic: { name: 'mcp' } }] },
      openIssues: { totalCount: 3 }, closedIssues: { totalCount: 9 }, releases: { totalCount: 2, nodes: [{ tagName: 'v0.3.0', publishedAt: '2026-10-28T00:00:00Z', description: 'notes' }] },
      readme: { byteSize: 4000, text: '# Agent Tool\nWorks with Claude Code.' }, readmeLower: null,
      defaultBranchRef: { target: { oid: 'abcdef1234567890', committedDate: '2026-10-28T00:00:00Z', c30: { totalCount: 25 }, c90: { totalCount: 30, nodes: [{ author: { user: { login: 'a' } } }, { author: { user: { login: 'b' } } }, { author: { user: { login: 'a' } } }] } } }
    } } };
  };
  const r = await S.enrichGithub(items, { gh, now }, { limits: { excerptChars: 100 } });
  assert.equal(r.enriched, 1);
  const s = items[0].signals;
  assert.deepEqual([s.stars, s.commits30, s.contributors90, s.lastReleaseTag, s.license, s.sha], [540, 25, 2, 'v0.3.0', 'MIT', 'abcdef123456']);
  assert.equal(s.starsPerDay, 270);
  assert.equal(items[0].title, 'Acme/agent-tool');
  assert.match(items[0].readme, /Claude Code/);
});
