import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";

function version(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function checks() {
  const node = process.versions.node;
  const python = version("python", ["--version"]);
  const git = version("git", ["--version"]);
  const fs = statfsSync(process.cwd());
  const freeGb = (fs.bavail * fs.bsize) / 1e9;
  return [
    { name: "node", ok: node.startsWith("22."), detail: node },
    { name: "python", ok: Boolean(python && /3\.(1[2-9])/.test(python)), detail: python ?? "missing" },
    { name: "git", ok: Boolean(git), detail: git ?? "missing" },
    { name: "disk", ok: freeGb >= 10, detail: freeGb.toFixed(1) + " GB free" },
  ];
}

export async function doctor(opts = {}) {
  const results = checks();
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) console.log((r.ok ? "ok   " : "FAIL ") + r.name.padEnd(8) + r.detail);
  }
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
