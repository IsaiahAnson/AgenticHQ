import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonFeed } from "../src/feed.js";

const site = { title: "Test", url: "https://example.org" };

test("json feed keeps the newest 20 posts", () => {
  const posts = Array.from({ length: 25 }, (_, i) => ({
    title: "Post " + i,
    slug: "post-" + i,
    date: "2026-10-" + String(i + 1).padStart(2, "0"),
    summary: "",
    tags: [],
  }));
  const feed = jsonFeed(site, posts);
  assert.equal(feed.items.length, 20);
  assert.equal(feed.items[0].url, "https://example.org/post-0/");
});

test("json feed declares version 1.1", () => {
  assert.match(jsonFeed(site, []).version, /version\/1\.1/);
});
