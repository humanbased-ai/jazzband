import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeAgentClient, type SpawnAgent, type SpawnResult } from "../src/agent/claudeClient.js";
import { resolveConfig } from "../src/core/config.js";
import { makeAgentDispatcher } from "../src/runtime/dispatcher.js";
import type { AppServerClient } from "../src/agent/runner.js";
import type { Issue } from "../src/core/types.js";

function issue(): Issue {
  return {
    id: "iss_1",
    identifier: "IN-1977",
    title: "role picker capped at 1",
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

function fakeSpawn(results: SpawnResult[], record: string[][]): SpawnAgent {
  const queue = [...results];
  return async (command, args) => {
    record.push([command, ...args]);
    return queue.shift() ?? { code: 0, stdout: '{"is_error":false}', timedOut: false };
  };
}

test("ClaudeAgentClient runs headless claude and maps a clean result to completed", async () => {
  const calls: string[][] = [];
  const spawnAgent = fakeSpawn([{ code: 0, stdout: '{"is_error":false,"session_id":"sess_1"}', timedOut: false }], calls);
  const client = new ClaudeAgentClient({ spawnAgent });

  await client.start({ cwd: "/ws/IN-1977", issue: issue() });
  const signal = await client.runTurn({ prompt: "fix it", continuation: false, threadId: "IN-1977" });

  assert.equal(signal, "completed");
  assert.deepEqual(calls[0], ["claude", "-p", "fix it", "--output-format", "json", "--model", "claude-opus-4-8", "--permission-mode", "acceptEdits"]);
});

test("continuation turns resume the captured session", async () => {
  const calls: string[][] = [];
  const spawnAgent = fakeSpawn(
    [
      { code: 0, stdout: '{"is_error":false,"session_id":"sess_9"}', timedOut: false },
      { code: 0, stdout: '{"is_error":false,"session_id":"sess_9"}', timedOut: false },
    ],
    calls,
  );
  const client = new ClaudeAgentClient({ spawnAgent });
  await client.start({ cwd: "/ws", issue: issue() });
  await client.runTurn({ prompt: "first", continuation: false, threadId: "t" });
  await client.runTurn({ prompt: "more", continuation: true, threadId: "t" });

  assert.ok(calls[1]!.includes("--resume"));
  assert.ok(calls[1]!.includes("sess_9"));
});

test("maps errors and timeouts to failing signals", async () => {
  const errClient = new ClaudeAgentClient({ spawnAgent: fakeSpawn([{ code: 0, stdout: '{"is_error":true}', timedOut: false }], []) });
  await errClient.start({ cwd: "/ws", issue: issue() });
  assert.equal(await errClient.runTurn({ prompt: "p", continuation: false, threadId: "t" }), "failed");

  const timeoutClient = new ClaudeAgentClient({ spawnAgent: fakeSpawn([{ code: null, stdout: "", timedOut: true }], []) });
  await timeoutClient.start({ cwd: "/ws", issue: issue() });
  assert.equal(await timeoutClient.runTurn({ prompt: "p", continuation: false, threadId: "t" }), "timeout");
});

test("makeAgentDispatcher prepares a workspace, renders the prompt, and drives the client", async () => {
  const root = mkdtempSync(join(tmpdir(), "jz-disp-"));
  const config = resolveConfig(
    { tracker: { kind: "linear", api_key: "k", project_slug: "p" }, workspace: { root } },
    { workflowDir: "/repo", env: {}, tempDir: "/tmp" },
  );

  let seenPrompt = "";
  const client: AppServerClient = {
    async start() {
      return { threadId: "t", pid: null };
    },
    async runTurn(opts) {
      seenPrompt = opts.prompt;
      return "completed";
    },
    async stop() {},
  };

  const outcomes: string[] = [];
  const dispatch = makeAgentDispatcher({
    config,
    promptTemplate: "Fix {{ issue.identifier }}: {{ issue.title }}",
    makeClient: () => client,
    onOutcome: (iss, outcome) => outcomes.push(`${iss.identifier}:${outcome.ok}`),
  });

  await dispatch(issue());
  assert.equal(seenPrompt, "Fix IN-1977: role picker capped at 1");
  assert.deepEqual(outcomes, ["IN-1977:true"]);
});
