import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeCliClassifier } from "../src/triage/claudeCliClassifier.js";
import type { SpawnAgent } from "../src/agent/claudeClient.js";
import type { Issue } from "../src/core/types.js";

function issue(): Issue {
  return {
    id: "iss_1",
    identifier: "IN-1977",
    title: "cant pick role up to 3",
    description: "says pick up to 3 but only one selectable",
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

function envelope(resultText: string): string {
  return JSON.stringify({ type: "result", is_error: false, result: resultText });
}

test("parses the claude CLI json envelope and its inner verdict", async () => {
  const spawnAgent: SpawnAgent = async () => ({
    code: 0,
    timedOut: false,
    stdout: envelope('{"verdict":"fixable","fingerprint":"role-picker","risk":"normal","surface":"portal:webapp","fixArea":"RoleForm.tsx","reason":"capped at one"}'),
  });
  const c = await new ClaudeCliClassifier({ spawnAgent }).classify(issue());
  assert.equal(c.issueId, "iss_1");
  assert.equal(c.verdict, "fixable");
  assert.equal(c.surface, "portal:webapp");
});

test("tolerates code fences and surrounding prose in the verdict text", async () => {
  const spawnAgent: SpawnAgent = async () => ({
    code: 0,
    timedOut: false,
    stdout: envelope('Here you go:\n```json\n{"verdict":"dangerous","fingerprint":"kyc","risk":"critical","surface":"portal:api","fixArea":"","reason":"identity"}\n```'),
  });
  const c = await new ClaudeCliClassifier({ spawnAgent }).classify(issue());
  assert.equal(c.verdict, "dangerous");
  assert.equal(c.risk, "critical");
});

test("rejects an invalid verdict and a failed CLI run", async () => {
  const bad: SpawnAgent = async () => ({ code: 0, timedOut: false, stdout: envelope('{"verdict":"maybe"}') });
  await assert.rejects(new ClaudeCliClassifier({ spawnAgent: bad }).classify(issue()), /invalid verdict/);

  const failed: SpawnAgent = async () => ({ code: 1, timedOut: false, stdout: "" });
  await assert.rejects(new ClaudeCliClassifier({ spawnAgent: failed }).classify(issue()), /classify failed/);
});
