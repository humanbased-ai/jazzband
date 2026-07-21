import assert from "node:assert/strict";
import { test } from "node:test";
import { CostMeter } from "../src/runtime/cost.js";

test("CostMeter accumulates spend and enforces a budget cap", () => {
  const m = new CostMeter(0.5);
  m.add(0.2);
  m.add(0.2);
  assert.equal(m.overBudget(), false);
  m.add(0.2); // 0.6 ≥ 0.5
  assert.equal(m.overBudget(), true);
  assert.match(m.summary(), /\$0\.6000 \/ \$0\.50 budget/);
});

test("no budget (0) never trips; bad values are ignored", () => {
  const m = new CostMeter(0);
  m.add(999);
  m.add(undefined);
  m.add(-5);
  m.add(NaN);
  assert.equal(m.overBudget(), false);
  assert.equal(m.totalUsd, 999);
});
