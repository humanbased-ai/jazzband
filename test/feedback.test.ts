import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeDelivery } from "../src/runtime/feedback.js";

test("summarizeDelivery counts only jazzband branches and computes acceptance", () => {
  const s = summarizeDelivery([
    { state: "MERGED", headRefName: "fix/in-1-jazzband" },
    { state: "CLOSED", headRefName: "fix/in-2-jazzband" },
    { state: "MERGED", headRefName: "fix/in-3-jazzband" },
    { state: "OPEN", headRefName: "fix/in-4-jazzband" },
    { state: "MERGED", headRefName: "feature/unrelated" }, // ignored (not jazzband)
  ]);
  assert.equal(s.merged, 2);
  assert.equal(s.closed, 1);
  assert.equal(s.open, 1);
  assert.equal(s.acceptancePct, 67); // 2 / (2+1)
  assert.equal(s.rows.length, 4);
});

test("acceptance is null when nothing is resolved yet", () => {
  const s = summarizeDelivery([{ state: "OPEN", headRefName: "fix/in-9-jazzband" }]);
  assert.equal(s.acceptancePct, null);
});
