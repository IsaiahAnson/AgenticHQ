import { readdir, stat, copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";

export async function plan(from, to) {
  const steps = [];
  for (const entry of await readdir(from, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(from, path.join(entry.parentPath, entry.name));
    const src = await stat(path.join(from, rel));
    const dst = await stat(path.join(to, rel)).catch(() => null);
    if (!dst || dst.mtimeMs < src.mtimeMs || dst.size !== src.size) steps.push({ op: "copy", rel });
  }
  return steps;
}

export async function sync(from, to, opts = {}) {
  const steps = await plan(from, to);
  for (const step of steps) {
    console.log((opts.dryRun ? "would copy " : "copy ") + step.rel);
    if (opts.dryRun) continue;
    await mkdir(path.dirname(path.join(to, step.rel)), { recursive: true });
    await copyFile(path.join(from, step.rel), path.join(to, step.rel));
  }
  if (opts.delete && !opts.dryRun) await removeMissing(from, to);
  return steps.length;
}

async function removeMissing(from, to) {
  for (const entry of await readdir(to, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const rel = path.relative(to, path.join(entry.parentPath, entry.name));
    const exists = await stat(path.join(from, rel)).then(() => true, () => false);
    if (!exists) await rm(path.join(to, rel));
  }
}
