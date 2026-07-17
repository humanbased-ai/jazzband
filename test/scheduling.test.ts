import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTINUATION_RETRY_DELAY_MS,
  failureBackoffMs,
  isDispatchEligible,
  selectDispatch,
  sortByDispatchPriority,
  type EligibilityContext,
} from "../src/core/scheduling.js";
import type { Issue } from "../src/core/types.js";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "iss",
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

const CTX: EligibilityContext = {
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done", "Canceled"],
  running: new Set<string>(),
  claimed: new Set<string>(),
};

test("failure backoff doubles per attempt and caps at the configured max", () => {
  assert.equal(failureBackoffMs(1, 300000), 10000);
  assert.equal(failureBackoffMs(2, 300000), 20000);
  assert.equal(failureBackoffMs(3, 300000), 40000);
  assert.equal(failureBackoffMs(10, 300000), 300000); // capped
  assert.equal(CONTINUATION_RETRY_DELAY_MS, 1000);
});

test("eligibility honors active/terminal state, running, and claimed sets", () => {
  assert.equal(isDispatchEligible(issue({ id: "a", state: "In Progress" }), CTX), true);
  assert.equal(isDispatchEligible(issue({ id: "a", state: "Done" }), CTX), false);
  assert.equal(isDispatchEligible(issue({ id: "a", state: "Backlog" }), CTX), false);
  assert.equal(isDispatchEligible(issue({ id: "a", title: "" }), CTX), false);
  assert.equal(
    isDispatchEligible(issue({ id: "a" }), { ...CTX, running: new Set(["a"]) }),
    false,
  );
  assert.equal(
    isDispatchEligible(issue({ id: "a" }), { ...CTX, claimed: new Set(["a"]) }),
    false,
  );
});

test("Todo issues are blocked by any non-terminal blocker but not by terminal ones", () => {
  const openBlocker = issue({ blockedBy: [{ id: "b", identifier: "IN-9", state: "In Progress" }] });
  assert.equal(isDispatchEligible(openBlocker, CTX), false);

  const doneBlocker = issue({ blockedBy: [{ id: "b", identifier: "IN-9", state: "Done" }] });
  assert.equal(isDispatchEligible(doneBlocker, CTX), true);

  const unknownBlocker = issue({ blockedBy: [{ id: "b", identifier: "IN-9", state: null }] });
  assert.equal(isDispatchEligible(unknownBlocker, CTX), false);

  // Non-Todo states are not gated by blockers.
  const inProgress = issue({
    state: "In Progress",
    blockedBy: [{ id: "b", identifier: "IN-9", state: "In Progress" }],
  });
  assert.equal(isDispatchEligible(inProgress, CTX), true);
});

test("dispatch sort orders by priority, then createdAt, then identifier", () => {
  const sorted = sortByDispatchPriority([
    issue({ identifier: "IN-3", priority: null, createdAt: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "IN-1", priority: 2, createdAt: "2026-01-02T00:00:00Z" }),
    issue({ identifier: "IN-2", priority: 2, createdAt: "2026-01-01T00:00:00Z" }),
    issue({ identifier: "IN-0", priority: 1, createdAt: "2026-01-05T00:00:00Z" }),
  ]);
  assert.deepEqual(sorted.map((i) => i.identifier), ["IN-0", "IN-2", "IN-1", "IN-3"]);
});

test("selectDispatch respects global and per-state concurrency limits", () => {
  const candidates = [
    issue({ id: "a", identifier: "IN-1", state: "Todo", priority: 1 }),
    issue({ id: "b", identifier: "IN-2", state: "Todo", priority: 2 }),
    issue({ id: "c", identifier: "IN-3", state: "In Progress", priority: 1 }),
  ];

  const global = selectDispatch(candidates, CTX, {
    maxConcurrentAgents: 2,
    maxConcurrentAgentsByState: {},
  }, { total: 0, byState: {} });
  assert.deepEqual(global.map((i) => i.id), ["a", "c"]); // 2 slots, sorted a(p1) c(p1) b(p2)

  const perState = selectDispatch(candidates, CTX, {
    maxConcurrentAgents: 10,
    maxConcurrentAgentsByState: { todo: 1 },
  }, { total: 0, byState: {} });
  assert.deepEqual(perState.map((i) => i.id), ["a", "c"]); // only 1 Todo allowed → a, plus c (In Progress)

  const runningFull = selectDispatch(candidates, CTX, {
    maxConcurrentAgents: 3,
    maxConcurrentAgentsByState: {},
  }, { total: 3, byState: { todo: 3 } });
  assert.deepEqual(runningFull, []); // no global slots left
});
