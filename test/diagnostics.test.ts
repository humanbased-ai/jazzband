import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveConfig } from "../src/core/config.js";
import { chooseClassifier, fetchWithAutoStates } from "../src/runtime/diagnostics.js";
import { JazzbandError } from "../src/core/errors.js";
import type { Issue, ServiceConfig } from "../src/core/types.js";

function cfg(overrides: Record<string, unknown> = {}): ServiceConfig {
  return resolveConfig(
    { tracker: { kind: "linear", api_key: "k", project_slug: "p" }, classifier: { runner: "claude-cli" }, ...overrides },
    { workflowDir: "/r", env: {}, tempDir: "/tmp" },
  );
}

test("chooseClassifier prefers a logged-in claude, else degrades through env creds", () => {
  const base = cfg();
  assert.equal(chooseClassifier(base, { claudeLoggedIn: true, env: {} }).backend, "claude-cli (logged in)");
  assert.match(
    chooseClassifier(base, { claudeLoggedIn: false, env: { ANTHROPIC_API_KEY: "sk" } }).backend,
    /api-key \(env/,
  );
  assert.match(
    chooseClassifier(base, { claudeLoggedIn: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat" } }).backend,
    /CLAUDE_CODE_OAUTH_TOKEN/,
  );
});

test("chooseClassifier throws clear guidance when no auth is available", () => {
  assert.throws(
    () => chooseClassifier(cfg(), { claudeLoggedIn: false, env: {} }),
    (e: unknown) => e instanceof JazzbandError && /No usable Claude auth/.test(e.message),
  );
});

test("explicit config credentials win over probing", () => {
  const withKey = cfg({ classifier: { api_key: "sk-config" } });
  assert.equal(chooseClassifier(withKey, { claudeLoggedIn: false, env: {} }).backend, "api-key (config)");
});

function issue(id: string, state: string): Issue {
  return { id, identifier: id, title: "t", description: null, priority: null, state, branchName: null, url: null, prNumber: null, labels: [], blockedBy: [], createdAt: null, updatedAt: null };
}

test("fetchWithAutoStates widens to common states when the configured states are empty", async () => {
  const backlog = [issue("a", "Backlog")];
  const fetch = async (states: string[]) => (states.includes("Backlog") ? backlog : []);

  const widened = await fetchWithAutoStates(fetch, ["Todo", "In Progress"]);
  assert.equal(widened.widened, true);
  assert.ok(widened.states.includes("Backlog"));
  assert.equal(widened.issues.length, 1);

  const noWiden = await fetchWithAutoStates(async () => [issue("b", "Todo")], ["Todo"]);
  assert.equal(noWiden.widened, false);
});
