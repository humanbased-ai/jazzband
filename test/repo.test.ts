import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { populateWorkspace, RepoError, type GitRunner } from "../src/core/repo.js";

function recordingGit(fail?: string): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    if (fail && args[0] === fail) return { code: 1, stderr: "boom" };
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

test("a fresh workspace is shallow-cloned at the base branch", async () => {
  const path = mkdtempSync(join(tmpdir(), "jz-repo-")); // empty, no .git
  const { runner, calls } = recordingGit();
  await populateWorkspace({ path, repo: "git@github.com:o/r.git", base: "main", runner });
  assert.deepEqual(calls, [["clone", "--depth", "1", "--branch", "main", "git@github.com:o/r.git", "."]]);
});

test("a reused workspace fetches, resets, and cleans instead of re-cloning", async () => {
  const path = mkdtempSync(join(tmpdir(), "jz-repo-"));
  mkdirSync(join(path, ".git")); // looks like an existing checkout
  const { runner, calls } = recordingGit();
  await populateWorkspace({ path, repo: "git@github.com:o/r.git", base: "staging", runner });
  assert.deepEqual(calls, [
    ["fetch", "--depth", "1", "origin", "staging"],
    ["checkout", "-f", "staging"],
    ["reset", "--hard", "origin/staging"],
    ["clean", "-fd"],
  ]);
});

test("a failing git step raises RepoError", async () => {
  const path = mkdtempSync(join(tmpdir(), "jz-repo-"));
  const { runner } = recordingGit("clone");
  await assert.rejects(
    populateWorkspace({ path, repo: "git@github.com:o/r.git", base: "main", runner }),
    RepoError,
  );
});
