import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearWriteClient } from "../src/linear/writes.js";
import { LinearError } from "../src/linear/errors.js";
import { applyTriage, type TriageWriter } from "../src/triage/executor.js";
import type { GraphQLResponse, Transport } from "../src/linear/client.js";
import type { Issue, TrackerConfig } from "../src/core/types.js";
import type { TriagePlan } from "../src/triage/types.js";

const TRACKER: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "lin_api_test",
  projectSlug: "bugs",
  activeStates: ["Backlog"],
  terminalStates: ["Done"],
};

function ok(body: unknown): GraphQLResponse {
  return { status: 200, body };
}

test("ensureLabelId reuses an existing team label and creates a missing one", async () => {
  const calls: string[] = [];
  const transport: Transport = async (_url, payload) => {
    const { query, variables } = payload as { query: string; variables: Record<string, unknown> };
    if (query.includes("projects(filter")) return ok({ data: { projects: { nodes: [{ teams: { nodes: [{ id: "team1" }] } }] } } });
    if (query.includes("team(id:")) return ok({ data: { team: { labels: { nodes: [{ id: "lbl_bug", name: "triage:fixable" }] } } } });
    if (query.includes("issueLabelCreate")) {
      calls.push(`create:${variables.name}`);
      return ok({ data: { issueLabelCreate: { success: true, issueLabel: { id: "lbl_new" } } } });
    }
    return ok({ data: {} });
  };
  const client = new LinearWriteClient(TRACKER, { transport });

  assert.equal(await client.ensureLabelId("triage:fixable"), "lbl_bug"); // existing
  assert.equal(await client.ensureLabelId("triage:dangerous"), "lbl_new"); // created
  assert.deepEqual(calls, ["create:triage:dangerous"]);
});

test("write client maps graphql errors to a coded error", async () => {
  const transport: Transport = async () => ok({ errors: [{ message: "bad" }] });
  await assert.rejects(
    new LinearWriteClient(TRACKER, { transport }).createComment("iss", "hi"),
    (e: unknown) => e instanceof LinearError && e.code === "linear_graphql_errors",
  );
});

function issue(id: string, title: string): Issue {
  return {
    id,
    identifier: id,
    title,
    description: null,
    priority: null,
    state: "Backlog",
    branchName: null,
    url: null,
    prNumber: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

test("applyTriage labels/comments all decisions and promotes only fixable ones", async () => {
  const added: string[] = [];
  const comments: string[] = [];
  const updates: Array<{ id: string; input: unknown }> = [];
  const writer: TriageWriter = {
    async addLabel(id, name) {
      added.push(`${id}:${name}`);
    },
    async createComment(id) {
      comments.push(id);
    },
    async resolveStateId() {
      return "state_todo";
    },
    async updateIssue(id, input) {
      updates.push({ id, input });
    },
  };

  const plan: TriagePlan = {
    decisions: [
      { issue: issue("IN-1", "role bug"), verdict: "fixable", labels: ["triage:fixable"], duplicateOf: null, promote: true, reason: "r" },
      { issue: issue("IN-2", "kyc"), verdict: "dangerous", labels: ["triage:dangerous", "security"], duplicateOf: null, promote: false, reason: "r" },
    ],
  };

  const result = await applyTriage(plan, writer, { promote: { projectId: "proj_intake", stateName: "Todo" } });

  assert.deepEqual(result, { labeled: 2, promoted: 1 });
  assert.deepEqual(added, ["IN-1:triage:fixable", "IN-2:triage:dangerous", "IN-2:security"]);
  assert.deepEqual(comments, ["IN-1", "IN-2"]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    id: "IN-1",
    input: { title: "[supply · bug] Online — role bug", stateId: "state_todo", projectId: "proj_intake" },
  });
});
