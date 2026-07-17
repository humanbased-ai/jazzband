import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentError } from "../src/agent/errors.js";
import { makeEvent } from "../src/agent/events.js";
import { parseToolInput, runLinearGraphqlTool } from "../src/agent/linearGraphqlTool.js";
import { runAttempt, type AppServerClient } from "../src/agent/runner.js";
import { classifyTurn, turnErrorCode, turnEventName, type TurnSignal } from "../src/agent/turn.js";
import type { Issue } from "../src/core/types.js";

const FIXED_NOW = () => "2026-07-17T00:00:00.000Z";

function issue(): Issue {
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
  };
}

test("makeEvent stamps an injected clock and defaults pid to null", () => {
  const event = makeEvent("session_started", { now: FIXED_NOW });
  assert.equal(event.timestamp, "2026-07-17T00:00:00.000Z");
  assert.equal(event.codexAppServerPid, null);
});

test("turn classification maps signals to success, event names, and error codes", () => {
  assert.deepEqual(classifyTurn("completed"), { ok: true, signal: "completed" });
  assert.equal(classifyTurn("failed").ok, false);
  assert.equal(turnEventName("completed"), "turn_completed");
  assert.equal(turnEventName("timeout"), "turn_ended_with_error");
  assert.equal(turnErrorCode("timeout"), "turn_timeout");
  assert.equal(turnErrorCode("subprocess_exit"), "port_exit");
});

test("linear_graphql tool validates single-operation, non-empty input", () => {
  assert.deepEqual(parseToolInput({ query: "query { viewer { id } }" }), {
    query: "query { viewer { id } }",
    variables: {},
  });
  assert.ok("error" in parseToolInput({ query: "" }));
  assert.ok("error" in parseToolInput({ query: "query A { a } query B { b }" }));
  assert.ok("error" in parseToolInput({ query: "{ viewer { id } }", variables: [] }));
  // raw string shorthand + anonymous selection counts as one operation
  assert.deepEqual(parseToolInput("{ viewer { id } }"), { query: "{ viewer { id } }", variables: {} });
});

test("linear_graphql tool maps transport, graphql errors, and success", async () => {
  const success = await runLinearGraphqlTool(
    { query: "query { viewer { id } }" },
    async () => ({ status: 200, body: { data: { viewer: { id: "u1" } } } }),
  );
  assert.equal(success.success, true);

  const gqlErrors = await runLinearGraphqlTool(
    { query: "query { nope }" },
    async () => ({ status: 200, body: { errors: [{ message: "bad" }] } }),
  );
  assert.equal(gqlErrors.success, false);
  assert.ok(gqlErrors.data); // body preserved for debugging

  const transport = await runLinearGraphqlTool({ query: "query { a }" }, async () => {
    throw new Error("boom");
  });
  assert.equal(transport.success, false);
  assert.match(transport.error ?? "", /transport failure/);

  const invalid = await runLinearGraphqlTool({ query: "" }, async () => ({ status: 200, body: {} }));
  assert.equal(invalid.success, false);
});

function scriptedClient(signals: TurnSignal[]): AppServerClient & { stopped: number } {
  const queue = [...signals];
  const client = {
    stopped: 0,
    async start() {
      return { threadId: "thread-1", pid: "4242" };
    },
    async runTurn() {
      return queue.shift() ?? "completed";
    },
    async stop() {
      client.stopped += 1;
    },
  };
  return client;
}

test("runAttempt runs one turn, forwards events, and stops the client", async () => {
  const events: string[] = [];
  const client = scriptedClient(["completed"]);
  const outcome = await runAttempt({
    issue: issue(),
    prompt: "do the thing",
    workspacePath: "/ws/IN-1",
    cwd: "/ws/IN-1",
    client,
    onEvent: (e) => events.push(e.event),
    maxTurns: 20,
    now: FIXED_NOW,
  });

  assert.deepEqual(outcome, { ok: true, turns: 1, threadId: "thread-1", error: null });
  assert.deepEqual(events, ["session_started", "turn_completed"]);
  assert.equal(client.stopped, 1);
});

test("runAttempt continues on the live thread only while shouldContinue and under maxTurns", async () => {
  const client = scriptedClient(["completed", "completed", "completed"]);
  const outcome = await runAttempt({
    issue: issue(),
    prompt: "p",
    workspacePath: "/ws/IN-1",
    cwd: "/ws/IN-1",
    client,
    onEvent: () => {},
    maxTurns: 2,
    shouldContinue: () => true,
    now: FIXED_NOW,
  });
  assert.equal(outcome.turns, 2); // capped by maxTurns
  assert.equal(client.stopped, 1);
});

test("runAttempt fails the attempt on a failing turn signal", async () => {
  const client = scriptedClient(["failed"]);
  const outcome = await runAttempt({
    issue: issue(),
    prompt: "p",
    workspacePath: "/ws/IN-1",
    cwd: "/ws/IN-1",
    client,
    onEvent: () => {},
    maxTurns: 20,
    now: FIXED_NOW,
  });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.error instanceof AgentError);
  assert.equal(outcome.error?.code, "turn_failed");
  assert.equal(client.stopped, 1); // stopped even on failure
});
