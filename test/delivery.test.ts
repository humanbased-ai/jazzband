import assert from "node:assert/strict";
import { test } from "node:test";
import { openPullRequest, type Exec, type ExecResult } from "../src/runtime/delivery.js";
import type { Issue } from "../src/core/types.js";

function issue(): Issue {
  return {
    id: "iss_1",
    identifier: "IN-2069",
    title: "campaign watch button not working",
    description: null,
    priority: null,
    state: "Backlog",
    branchName: null,
    url: "https://linear.app/x/IN-2069",
    prNumber: null,
    labels: ["triage:fixable"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

/** Fake exec: records calls; `porcelain` controls the git status output; gh returns a PR url. */
function fakeExec(porcelain: string, opts: { names?: string; diff?: string; existingPr?: string } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const out = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (command === "git" && args[0] === "status") return out(porcelain);
    if (command === "git" && args[0] === "diff" && args.includes("--name-only")) return out(opts.names ?? "");
    if (command === "git" && args[0] === "diff") return out(opts.diff ?? "");
    if (command === "gh" && args.includes("list")) return out(opts.existingPr ?? ""); // idempotency probe
    if (command === "gh") return out("https://github.com/humanbased-ai/monorepo/pull/1420\n"); // pr create
    return out();
  };
  return { exec, calls };
}

const OPTS = {
  workspacePath: "/ws/IN-2069",
  issue: issue(),
  base: "staging",
  repo: "humanbased-ai/monorepo",
  remoteUrl: "https://github.com/humanbased-ai/monorepo.git",
};

test("opens a PR: branch, commit, push, gh pr create — returns the URL", async () => {
  const { exec, calls } = fakeExec(" M frontend/x.tsx\n");
  const result = await openPullRequest({ ...OPTS, exec });

  assert.deepEqual(result, {
    opened: true,
    prUrl: "https://github.com/humanbased-ai/monorepo/pull/1420",
    branch: "fix/in-2069-jazzband",
  });
  const verbs = calls.map((c) => `${c[0]} ${c[1]}`);
  for (const step of ["git checkout", "git add", "git commit", "git push"]) {
    assert.ok(verbs.includes(step), `expected ${step}`);
  }
  const gh = calls.find((c) => c[0] === "gh" && c.includes("create"))!;
  assert.ok(gh.includes("--repo") && gh.includes("humanbased-ai/monorepo") && gh.includes("staging"));
});

test("idempotency: skips when an open PR already exists for the branch", async () => {
  const { exec } = fakeExec(" M x.tsx\n", { existingPr: "https://github.com/o/r/pull/99\n" });
  const result = await openPullRequest({ ...OPTS, exec });
  assert.equal(result.opened, false);
  assert.match((result as { reason: string }).reason, /already open.*pull\/99/);
});

test("guardrails block forbidden paths, oversized diffs, and secrets", async () => {
  const forbidden = fakeExec(" M x\n", { names: "backend/.env\nsrc/a.ts\n" });
  const r1 = await openPullRequest({ ...OPTS, exec: forbidden.exec, forbiddenPaths: [".env"] });
  assert.match((r1 as { reason: string }).reason, /forbidden path.*\.env/);

  const big = fakeExec(" M x\n", { names: "a.ts\n", diff: Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n") });
  const r2 = await openPullRequest({ ...OPTS, exec: big.exec, maxDiffLines: 10 });
  assert.match((r2 as { reason: string }).reason, /exceeds max 10/);

  const secret = fakeExec(" M x\n", { names: "a.ts\n", diff: "+const k = 'sk-ant-abcdefghijklmnop'" });
  const r3 = await openPullRequest({ ...OPTS, exec: secret.exec, secretScan: true });
  assert.match((r3 as { reason: string }).reason, /secret/);
});

test("the agent's summary becomes the PR body", async () => {
  const { exec, calls } = fakeExec(" M x.tsx\n");
  await openPullRequest({ ...OPTS, exec, body: "## What was wrong\nThe Watch toggle rolled back." });
  const gh = calls.find((c) => c[0] === "gh" && c.includes("create"))!;
  const bodyIdx = gh.indexOf("--body");
  assert.match(gh[bodyIdx + 1]!, /What was wrong[\s\S]*Watch toggle rolled back/);
  assert.match(gh[bodyIdx + 1]!, /Opened by Jazzband/); // footer preserved
});

test("skips the PR when the agent produced no changes", async () => {
  const { exec, calls } = fakeExec("");
  const result = await openPullRequest({ ...OPTS, exec });
  assert.deepEqual(result, { opened: false, reason: "agent made no changes" });
  assert.deepEqual(calls, [["git", "status", "--porcelain"]]); // stopped after status
});

test("verify gate blocks the PR when the check fails, and allows it when it passes", async () => {
  // Failing verify → no PR, and we never reach git checkout.
  const failCalls: string[][] = [];
  const failExec: Exec = async (command, args) => {
    failCalls.push([command, ...args]);
    if (command === "git" && args[0] === "status") return { code: 0, stdout: " M x.tsx\n", stderr: "" };
    if (command === "bash") return { code: 1, stdout: "", stderr: "2 tests failed" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const blocked = await openPullRequest({ ...OPTS, exec: failExec, verify: "npm test" });
  assert.equal(blocked.opened, false);
  assert.match((blocked as { reason: string }).reason, /verify failed/);
  assert.ok(!failCalls.some((c) => c[0] === "git" && c[1] === "checkout")); // never branched

  // Passing verify → PR opens.
  const { exec } = fakeExec(" M x.tsx\n");
  const passExec: Exec = async (command, args) =>
    command === "bash" ? { code: 0, stdout: "", stderr: "" } : exec(command, args, { cwd: "", timeoutMs: 0 });
  const opened = await openPullRequest({ ...OPTS, exec: passExec, verify: "npm test" });
  assert.equal(opened.opened, true);
});
