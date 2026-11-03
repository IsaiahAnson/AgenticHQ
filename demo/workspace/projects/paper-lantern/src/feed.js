import { writeFile } from "node:fs/promises";
import path from "node:path";

export function jsonFeed(site, posts) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: site.title,
    home_page_url: site.url,
    items: posts.slice(0, 20).map((p) => ({
      id: site.url + "/" + p.slug + "/",
      url: site.url + "/" + p.slug + "/",
      title: p.title,
      summary: p.summary,
      date_published: p.date,
      tags: p.tags,
    })),
  };
}

export async function buildFeeds(outDir, posts, site = { title: "Paper Lantern", url: "https://example.org" }) {
  await writeFile(path.join(outDir, "feed.json"), JSON.stringify(jsonFeed(site, posts), null, 2));
}
