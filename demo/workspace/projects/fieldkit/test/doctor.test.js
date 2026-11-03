import { test } from "node:test";
import assert from "node:assert/strict";
import { checks } from "../src/commands/doctor.js";
import { snapId } from "../src/commands/snap.js";

test("doctor reports the four core checks", () => {
  const names = checks().map((c) => c.name);
  assert.deepEqual(names, ["node", "python", "git", "disk"]);
});

test("snap ids sort by time and are safe file names", () => {
  const id = snapId(new Date("2026-10-23T14:10:00Z"));
  assert.equal(id, "2026-10-23T14-10");
  assert.doesNotMatch(id, /[:\\/]/);
});
