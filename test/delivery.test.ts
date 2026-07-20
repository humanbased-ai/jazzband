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
function fakeExec(porcelain: string): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (command, args) => {
    calls.push([command, ...args]);
    const out = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
    if (command === "git" && args[0] === "status") return out(porcelain);
    if (command === "gh") return out("https://github.com/humanbased-ai/monorepo/pull/1420\n");
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
  assert.deepEqual(verbs, [
    "git status",
    "git checkout",
    "git add",
    "git commit",
    "git remote",
    "git push",
    "gh pr",
  ]);
  const gh = calls.find((c) => c[0] === "gh")!;
  assert.ok(gh.includes("--repo") && gh.includes("humanbased-ai/monorepo") && gh.includes("staging"));
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
