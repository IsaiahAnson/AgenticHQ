import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { renderMarkdown } from "./markdown.js";
import { buildFeeds } from "./feed.js";

export async function build({ root, out = "site", theme = "plain", cache = new Map() }) {
  const postsDir = path.join(root, "content", "posts");
  const files = (await readdir(postsDir)).filter((f) => f.endsWith(".md"));
  const posts = [];
  let rebuilt = 0;

  for (const file of files) {
    const full = path.join(postsDir, file);
    const { mtimeMs } = await stat(full);
    const post = renderMarkdown(await readFile(full, "utf8"), file);
    posts.push(post);
    if (cache.get(full) === mtimeMs) continue;
    cache.set(full, mtimeMs);
    const dest = path.join(root, out, post.slug, "index.html");
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await applyTheme(root, theme, "post.html", post));
    rebuilt += 1;
  }

  posts.sort((a, b) => b.date.localeCompare(a.date));
  await buildFeeds(path.join(root, out), posts);
  return { posts: posts.length, rebuilt };
}

async function applyTheme(root, theme, template, values) {
  const html = await readFile(path.join(root, "themes", theme, template), "utf8");
  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(values[key] ?? ""));
}
