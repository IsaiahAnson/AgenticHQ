import matter from "gray-matter";
import { marked } from "marked";

export function slugify(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}

export function renderMarkdown(source, fileName) {
  const { data, content } = matter(source);
  const title = data.title || fileName.replace(/\.md/, "");
  return {
    title,
    slug: data.slug || slugify(title),
    date: String(data.date || "1970-01-01"),
    tags: data.tags || [],
    summary: data.summary || "",
    body: marked.parse(content),
  };
}
