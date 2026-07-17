import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/core/config.js";
import { Runtime, type RuntimeSource, type Worker } from "../src/runtime/runtime.js";
import type { Issue, ServiceConfig } from "../src/core/types.js";

function config(overrides: Record<string, unknown> = {}): ServiceConfig {
  return resolveConfig(
    {
      tracker: { kind: "linear", api_key: "k", project_slug: "p", active_states: ["Backlog"], terminal_states: ["Done"] },
      agent: { max_concurrent_agents: 5 },
      ...overrides,
    },
    { workflowDir: "/repo", env: {}, tempDir: "/tmp" },
  );
}

function issue(id: string, labels: string[] = ["triage:fixable"], state = "Backlog"): Issue {
  return {
    id,
    identifier: id.toUpperCase(),
    title: "t",
    description: null,
    priority: null,
    state,
    branchName: null,
    url: null,
    prNumber: null,
    labels,
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

function source(candidates: Issue[], byId: Issue[] = []): RuntimeSource {
  return {
    fetchCandidateIssues: async () => candidates,
    fetchIssueStatesByIds: async (ids) => byId.filter((i) => ids.includes(i.id)),
  };
}

test("only dispatches issues labeled triage:fixable", async () => {
  const worked: string[] = [];
  const worker: Worker = async (i) => {
    worked.push(i.id);
    return { ok: true };
  };
  const rt = new Runtime({
    config: config(),
    source: source([issue("a", ["triage:fixable"]), issue("b", ["triage:needs-confirmation"])]),
    worker,
    now: () => 0,
  });
  await Promise.all(await rt.tick());
  assert.deepEqual(worked, ["a"]);
});

test("a successful worker releases the claim so it is not re-dispatched while terminal", async () => {
  let calls = 0;
  const worker: Worker = async () => {
    calls += 1;
    return { ok: true };
  };
  // After the run, the issue is Done (terminal) — reconcile + candidate list reflect that.
  const rt = new Runtime({
    config: config(),
    source: {
      fetchCandidateIssues: async () => (calls === 0 ? [issue("a")] : []),
      fetchIssueStatesByIds: async () => [issue("a", ["triage:fixable"], "Done")],
    },
    worker,
    now: () => 0,
  });
  await Promise.all(await rt.tick());
  await Promise.all(await rt.tick());
  assert.equal(calls, 1); // dispatched once
});

test("a failed worker is retry-gated by backoff, then dispatched again once due", async () => {
  let calls = 0;
  const worker: Worker = async () => {
    calls += 1;
    return { ok: false };
  };
  let clock = 1_000_000;
  const rt = new Runtime({
    config: config(),
    source: source([issue("a")]),
    worker,
    now: () => clock,
  });

  await Promise.all(await rt.tick()); // attempt 1 fails → retryAt = now + 10000
  assert.equal(calls, 1);
  await Promise.all(await rt.tick()); // still within backoff window → skipped
  assert.equal(calls, 1);
  clock += 10_001; // past the 10s backoff
  await Promise.all(await rt.tick());
  assert.equal(calls, 2);
});

test("reconcile drops a running issue whose tracker state went terminal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const worker: Worker = async () => {
    await gate;
    return { ok: true };
  };
  const rt = new Runtime({
    config: config(),
    source: {
      fetchCandidateIssues: async () => [issue("a")],
      fetchIssueStatesByIds: async () => [issue("a", ["triage:fixable"], "Done")],
    },
    worker,
    now: () => 0,
  });

  const workers = await rt.tick(); // dispatch a; worker is blocked on the gate
  assert.deepEqual(rt.planDispatch([issue("a")]), []); // claimed → not re-dispatched
  await rt.tick(); // reconcile sees a is Done → releases it
  release();
  await Promise.all(workers);
});
