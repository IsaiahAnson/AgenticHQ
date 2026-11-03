import { mkdir, readdir, rm, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SNAP_DIR = path.join(os.homedir(), ".fieldkit", "snaps");
const KEEP_DAYS = 14;

export function snapId(date = new Date()) {
  return date.toISOString().slice(0, 16).replace(":", "-");
}

export async function snap(target = ".", opts = {}) {
  await mkdir(SNAP_DIR, { recursive: true });
  if (opts.list) {
    for (const id of (await readdir(SNAP_DIR)).sort()) console.log(id);
    return;
  }
  if (opts.restore) {
    await cp(path.join(SNAP_DIR, opts.restore), target, { recursive: true });
    return;
  }
  const id = snapId();
  await cp(target, path.join(SNAP_DIR, id), { recursive: true });
  await prune();
  console.log("snapshot " + id);
}

async function prune(now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const id of await readdir(SNAP_DIR)) {
    const when = Date.parse(id.slice(0, 10));
    if (when < cutoff) await rm(path.join(SNAP_DIR, id), { recursive: true, force: true });
  }
}
