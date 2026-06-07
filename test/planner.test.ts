import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkflowPlan } from "../src/core/planner.js";
import { main } from "../src/cli/main.js";

test("createWorkflowPlan returns the seed orchestration contract", () => {
  const plan = createWorkflowPlan({ ticket: "IN-123", repo: "humanbased-ai/monorepo" });

  assert.equal(plan.phase, "planned");
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.target, {
    ticket: "IN-123",
    repo: "humanbased-ai/monorepo",
  });
  assert.ok(plan.steps.some((step) => step.includes("Crosscheck")));
  assert.ok(plan.steps.some((step) => step.includes("VerifyFlow")));
});

test("CLI help exits successfully", async () => {
  const code = await main(["--help"]);
  assert.equal(code, 0);
});
