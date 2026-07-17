import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig, validateDispatchPreflight } from "../src/core/config.js";
import { JazzbandError } from "../src/core/errors.js";

const OPTS = { workflowDir: "/repo", env: {} as Record<string, string | undefined>, tempDir: "/tmp" };

test("applies documented defaults for an empty config", () => {
  const config = resolveConfig({}, OPTS);

  assert.equal(config.tracker.endpoint, "https://api.linear.app/graphql");
  assert.deepEqual(config.tracker.activeStates, ["Todo", "In Progress"]);
  assert.deepEqual(config.tracker.terminalStates, [
    "Closed",
    "Cancelled",
    "Canceled",
    "Duplicate",
    "Done",
  ]);
  assert.equal(config.polling.intervalMs, 30000);
  assert.equal(config.agent.maxConcurrentAgents, 10);
  assert.equal(config.agent.maxTurns, 20);
  assert.equal(config.codex.command, "codex app-server");
  assert.equal(config.codex.turnTimeoutMs, 3600000);
  assert.equal(config.workspace.root, "/tmp/jazzband_workspaces");
});

test("resolves tracker.api_key from a $VAR reference", () => {
  const config = resolveConfig(
    { tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "bugs" } },
    { ...OPTS, env: { LINEAR_API_KEY: "lin_api_123" } },
  );
  assert.equal(config.tracker.apiKey, "lin_api_123");
});

test("treats a $VAR api_key that resolves to empty as missing", () => {
  const config = resolveConfig(
    { tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: "bugs" } },
    { ...OPTS, env: { LINEAR_API_KEY: "" } },
  );
  assert.equal(config.tracker.apiKey, null);
});

test("expands ~ and resolves a relative workspace.root against the workflow dir", () => {
  const home = resolveConfig({ workspace: { root: "~/ws" } }, OPTS);
  assert.match(home.workspace.root, /\/ws$/);
  assert.ok(!home.workspace.root.includes("~"));

  const relative = resolveConfig({ workspace: { root: "runs" } }, OPTS);
  assert.equal(relative.workspace.root, "/repo/runs");
});

test("fails when workspace.root references a missing env var, naming the variable", () => {
  assert.throws(
    () => resolveConfig({ workspace: { root: "$WS_ROOT" } }, OPTS),
    (error: unknown) =>
      error instanceof JazzbandError &&
      error.code === "config_validation_error" &&
      error.message.includes("WS_ROOT"),
  );
});

test("rejects a non-positive max_turns", () => {
  assert.throws(
    () => resolveConfig({ agent: { max_turns: 0 } }, OPTS),
    (error: unknown) => error instanceof JazzbandError && error.code === "config_validation_error",
  );
});

test("normalizes per-state concurrency keys and rejects non-positive limits", () => {
  const config = resolveConfig(
    { agent: { max_concurrent_agents_by_state: { "In Progress": 2, Todo: 5 } } },
    OPTS,
  );
  assert.deepEqual(config.agent.maxConcurrentAgentsByState, { "in progress": 2, todo: 5 });

  assert.throws(
    () => resolveConfig({ agent: { max_concurrent_agents_by_state: { Todo: 0 } } }, OPTS),
    (error: unknown) => error instanceof JazzbandError && error.code === "config_validation_error",
  );
});

test("classifier config defaults to opus and resolves an auth token from $VAR", () => {
  const dflt = resolveConfig({}, OPTS);
  assert.equal(dflt.classifier.model, "claude-opus-4-8");
  assert.equal(dflt.classifier.apiKey, null);
  assert.equal(dflt.classifier.authToken, null);

  const configured = resolveConfig(
    { classifier: { model: "claude-haiku-4-5", auth_token: "$CLAUDE_TOKEN" } },
    { ...OPTS, env: { CLAUDE_TOKEN: "oauth_abc" } },
  );
  assert.equal(configured.classifier.model, "claude-haiku-4-5");
  assert.equal(configured.classifier.authToken, "oauth_abc");
  assert.equal(configured.classifier.apiKey, null);
});

test("preflight passes a complete linear config and flags a missing project_slug", () => {
  const complete = resolveConfig(
    { tracker: { kind: "linear", api_key: "lin_api_1", project_slug: "bugs" } },
    OPTS,
  );
  assert.doesNotThrow(() => validateDispatchPreflight(complete));

  const noSlug = resolveConfig({ tracker: { kind: "linear", api_key: "lin_api_1" } }, OPTS);
  assert.throws(
    () => validateDispatchPreflight(noSlug),
    (error: unknown) =>
      error instanceof JazzbandError && error.message.includes("project_slug"),
  );
});
