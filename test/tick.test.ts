import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/core/config.js";
import { planTick, runningCountsByState } from "../src/core/tick.js";
import type { Issue } from "../src/core/types.js";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "a",
    identifier: "IN-1",
    title: "t",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    prNumber: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

test("runningCountsByState tallies totals and normalized per-state counts", () => {
  assert.deepEqual(runningCountsByState(["Todo", "In Progress", "todo"]), {
    total: 3,
    byState: { todo: 2, "in progress": 1 },
  });
});

test("planTick dispatches eligible candidates under the config concurrency limit", () => {
  const config = resolveConfig(
    { tracker: { kind: "linear", api_key: "k", project_slug: "p" }, agent: { max_concurrent_agents: 1 } },
    { workflowDir: "/repo", env: {}, tempDir: "/tmp" },
  );

  const plan = planTick({
    candidates: [
      issue({ id: "a", identifier: "IN-1", priority: 2 }),
      issue({ id: "b", identifier: "IN-2", priority: 1 }),
    ],
    config,
    running: new Set(),
    claimed: new Set(),
    runningCounts: { total: 0, byState: {} },
  });

  assert.deepEqual(plan.dispatch.map((i) => i.id), ["b"]); // 1 slot, higher priority (lower number) wins
});
