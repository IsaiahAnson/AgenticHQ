import { describe, expect, it } from "vitest";
import { mergeOps } from "../src/sync/merge";
import type { Op } from "../src/sync/schema";

function op(noteId: string, field: Op["field"], value: unknown, wall: number, device = "a"): Op {
  return { id: noteId + field + wall, noteId, field, value, hlc: { wall, count: 0, device }, device };
}

describe("mergeOps", () => {
  it("keeps the newest edit per field", () => {
    const merged = mergeOps([op("n1", "title", "Draft", 10)], [op("n1", "title", "Final", 20)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toBe("Final");
  });

  it("keeps edits to different fields from both sides", () => {
    const merged = mergeOps([op("n1", "title", "Trip", 10)], [op("n1", "pinned", true, 5)]);
    expect(merged.map((o) => o.field).sort()).toEqual(["pinned", "title"]);
  });

  it("breaks ties on device id", () => {
    const merged = mergeOps([op("n1", "body", "from a", 10, "a")], [op("n1", "body", "from b", 10, "b")]);
    expect(merged[0]?.value).toBe("from b");
  });
});
