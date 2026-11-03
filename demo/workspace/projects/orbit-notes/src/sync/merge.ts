import type { Op, Hlc } from "./schema";

export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.count !== b.count) return a.count - b.count;
  return a.device < b.device ? -1 : a.device > b.device ? 1 : 0;
}

/** Keep the newest operation for each (noteId, field). */
export function mergeOps(local: Op[], remote: Op[]): Op[] {
  const winners = new Map<string, Op>();
  for (const op of [...local, ...remote]) {
    const key = op.noteId + "/" + op.field;
    const current = winners.get(key);
    if (!current || compareHlc(op.hlc, current.hlc) > 0) winners.set(key, op);
  }
  return [...winners.values()];
}
