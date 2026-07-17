import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/core/config.js";
import { newRuntimeState, tick, type CandidateSource } from "../src/runtime/loop.js";
import type { Issue, ServiceConfig } from "../src/core/types.js";

function config(overrides: Record<string, unknown> = {}): ServiceConfig {
  return resolveConfig(
    {
      tracker: { kind: "linear", api_key: "k", project_slug: "p" },
      agent: { max_concurrent_agents: 1 },
      ...overrides,
    },
    { workflowDir: "/repo", env: {}, tempDir: "/tmp" },
  );
}

function issue(id: string, identifier: string, priority: number): Issue {
  return {
    id,
    identifier,
    title: "t",
    description: null,
    priority,
    state: "Todo",
    branchName: null,
    url: null,
    prNumber: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function source(issues: Issue[]): CandidateSource {
  return { fetchCandidateIssues: async () => issues };
}

test("tick dispatches under the concurrency limit and forwards to the dispatcher", async () => {
  const dispatched: string[] = [];
  const result = await tick(
    { config: config(), source: source([issue("a", "IN-1", 2), issue("b", "IN-2", 1)]), dispatch: (i) => void dispatched.push(i.id) },
    newRuntimeState(),
  );
  assert.equal(result.skipped, false);
  assert.deepEqual(dispatched, ["b"]); // 1 slot, higher priority
});

test("a claimed issue is not re-dispatched on the next tick", async () => {
  const dispatched: string[] = [];
  const state = newRuntimeState();
  const deps = {
    config: config({ agent: { max_concurrent_agents: 5 } }),
    source: source([issue("a", "IN-1", 1)]),
    dispatch: (i: Issue) => void dispatched.push(i.id),
  };
  await tick(deps, state);
  await tick(deps, state);
  assert.deepEqual(dispatched, ["a"]); // dispatched once, then claimed
});

test("tick skips dispatch when preflight fails", async () => {
  const noKey = resolveConfig({ tracker: { kind: "linear", project_slug: "p" } }, { workflowDir: "/r", env: {}, tempDir: "/tmp" });
  const result = await tick(
    { config: noKey, source: source([issue("a", "IN-1", 1)]), dispatch: () => {} },
    newRuntimeState(),
  );
  assert.deepEqual(result, { dispatched: [], skipped: true });
});

test("tick skips dispatch when candidate fetch fails", async () => {
  const failing: CandidateSource = {
    fetchCandidateIssues: async () => {
      throw new Error("network down");
    },
  };
  const result = await tick({ config: config(), source: failing, dispatch: () => {} }, newRuntimeState());
  assert.equal(result.skipped, true);
});
