import assert from "node:assert/strict";
import { test } from "node:test";
import { LinearClient, type GraphQLResponse, type Transport } from "../src/linear/client.js";
import { LinearError } from "../src/linear/errors.js";
import { normalizeIssue } from "../src/linear/normalize.js";
import type { TrackerConfig } from "../src/core/types.js";

const TRACKER: TrackerConfig = {
  kind: "linear",
  endpoint: "https://api.linear.app/graphql",
  apiKey: "lin_api_test",
  projectSlug: "bugs",
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done"],
};

function ok(body: unknown): GraphQLResponse {
  return { status: 200, body };
}

function issueNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "iss_1",
    identifier: "IN-1",
    title: "Fix it",
    description: null,
    priority: 2,
    state: { name: "Todo" },
    branchName: null,
    url: "https://linear.app/x/IN-1",
    attachments: { nodes: [] },
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    createdAt: "2026-07-14T02:00:00.000Z",
    updatedAt: "2026-07-15T02:00:00.000Z",
    ...overrides,
  };
}

test("normalizeIssue lowercases labels, extracts blockers and PR number", () => {
  const issue = normalizeIssue(
    issueNode({
      labels: { nodes: [{ name: "Bug" }, { name: "Portal:WebApp" }] },
      attachments: { nodes: [{ url: "https://github.com/o/r/pull/42" }] },
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "b1", identifier: "IN-9", state: { name: "Todo" } } },
          { type: "related", issue: { id: "r1", identifier: "IN-8", state: { name: "Todo" } } },
        ],
      },
      priority: 3.5,
    }),
  );

  assert.deepEqual(issue.labels, ["bug", "portal:webapp"]);
  assert.equal(issue.prNumber, 42);
  assert.deepEqual(issue.blockedBy, [{ id: "b1", identifier: "IN-9", state: "Todo" }]);
  assert.equal(issue.priority, null); // non-integer priority → null
});

test("fetchCandidateIssues follows pagination across pages", async () => {
  const pages: GraphQLResponse[] = [
    ok({
      data: {
        issues: {
          nodes: [issueNode({ id: "iss_1", identifier: "IN-1" })],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        },
      },
    }),
    ok({
      data: {
        issues: {
          nodes: [issueNode({ id: "iss_2", identifier: "IN-2" })],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  ];
  const seen: unknown[] = [];
  const transport: Transport = async (_url, payload) => {
    seen.push((payload as { variables: unknown }).variables);
    return pages.shift()!;
  };

  const issues = await new LinearClient(TRACKER, { transport }).fetchCandidateIssues();
  assert.deepEqual(issues.map((i) => i.identifier), ["IN-1", "IN-2"]);
  assert.equal((seen[0] as { after: string | null }).after, null);
  assert.equal((seen[1] as { after: string | null }).after, "cursor-1");
});

test("fetchCandidateIssues errors when a next page lacks an end cursor", async () => {
  const transport: Transport = async () =>
    ok({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
    });
  await assert.rejects(
    new LinearClient(TRACKER, { transport }).fetchCandidateIssues(),
    (error: unknown) => error instanceof LinearError && error.code === "linear_missing_end_cursor",
  );
});

test("fetchIssueStatesByIds returns results in requested order", async () => {
  const transport: Transport = async () =>
    ok({
      data: {
        issues: {
          nodes: [issueNode({ id: "b", identifier: "IN-B" }), issueNode({ id: "a", identifier: "IN-A" })],
        },
      },
    });
  const issues = await new LinearClient(TRACKER, { transport }).fetchIssueStatesByIds(["a", "b"]);
  assert.deepEqual(issues.map((i) => i.id), ["a", "b"]);
});

test("maps non-200, graphql errors, and unknown payloads to coded errors", async () => {
  const status: Transport = async () => ({ status: 401, body: "nope" });
  await assert.rejects(
    new LinearClient(TRACKER, { transport: status }).fetchCandidateIssues(),
    (e: unknown) => e instanceof LinearError && e.code === "linear_api_status",
  );

  const gql: Transport = async () => ok({ errors: [{ message: "bad field" }] });
  await assert.rejects(
    new LinearClient(TRACKER, { transport: gql }).fetchCandidateIssues(),
    (e: unknown) => e instanceof LinearError && e.code === "linear_graphql_errors",
  );

  const junk: Transport = async () => ok("not an object");
  await assert.rejects(
    new LinearClient(TRACKER, { transport: junk }).fetchCandidateIssues(),
    (e: unknown) => e instanceof LinearError && e.code === "linear_unknown_payload",
  );
});

test("requires an api key and a project slug", async () => {
  const noKey = { ...TRACKER, apiKey: null };
  await assert.rejects(
    new LinearClient(noKey, { transport: async () => ok({}) }).fetchCandidateIssues(),
    (e: unknown) => e instanceof LinearError && e.code === "missing_tracker_api_key",
  );

  const noSlug = { ...TRACKER, projectSlug: null };
  await assert.rejects(
    new LinearClient(noSlug, { transport: async () => ok({}) }).fetchCandidateIssues(),
    (e: unknown) => e instanceof LinearError && e.code === "missing_tracker_project_slug",
  );
});
