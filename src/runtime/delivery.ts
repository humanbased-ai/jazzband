import { spawn } from "node:child_process";
import type { Issue } from "../core/types.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command in `cwd`, capturing stdout/stderr. Injectable so PR-opening is testable. */
export type Exec = (command: string, args: string[], options: { cwd: string; timeoutMs: number }) => Promise<ExecResult>;

export const defaultExec: Exec = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export interface OpenPrOptions {
  workspacePath: string;
  issue: Issue;
  base: string;
  repo: string;
  remoteUrl: string;
  /** Quality-gate command (bash -lc) run in the workspace; non-zero exit blocks the PR. */
  verify?: string | null;
  exec?: Exec;
  timeoutMs?: number;
}

export type OpenPrResult = { opened: true; prUrl: string; branch: string } | { opened: false; reason: string };

const REMOTE = "jazzband-origin";

function slug(issue: Issue): string {
  return `fix/${issue.identifier.toLowerCase()}-jazzband`;
}

/**
 * After the agent has edited the workspace, deterministically open the PR: branch off the current
 * tree, commit the changes, push to the GitHub remote, and `gh pr create`. If the agent produced
 * no changes, returns {opened:false} instead of an empty PR. Never merges (SPEC delivery boundary).
 */
export async function openPullRequest(options: OpenPrOptions): Promise<OpenPrResult> {
  const exec = options.exec ?? defaultExec;
  const timeoutMs = options.timeoutMs ?? 120000;
  const at = { cwd: options.workspacePath, timeoutMs };
  const branch = slug(options.issue);

  const status = await exec("git", ["status", "--porcelain"], at);
  if (status.stdout.trim() === "") {
    return { opened: false, reason: "agent made no changes" };
  }

  // Quality gate: don't open a PR whose change doesn't pass the configured check.
  if (options.verify && options.verify.trim() !== "") {
    const check = await exec("bash", ["-lc", options.verify], at);
    if (check.code !== 0) {
      return { opened: false, reason: `verify failed (exit ${check.code}): ${check.stderr.trim().slice(0, 200)}` };
    }
  }

  const run = async (cmd: string, args: string[], allowFail = false): Promise<ExecResult> => {
    const result = await exec(cmd, args, at);
    if (result.code !== 0 && !allowFail) {
      throw new DeliveryError(`${cmd} ${args[0]} failed (code=${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    }
    return result;
  };

  const title = `fix(${options.issue.identifier.toLowerCase()}): ${options.issue.title}`;
  const body = `Fixes ${options.issue.url ?? options.issue.identifier}.\n\n🤖 Opened by Jazzband. Do not merge without review.`;

  await run("git", ["checkout", "-b", branch]);
  await run("git", ["add", "-A"]);
  await run("git", ["commit", "-m", title, "-m", body]);
  await run("git", ["remote", "add", REMOTE, options.remoteUrl], true); // ok if it already exists
  await run("git", ["push", REMOTE, `HEAD:${branch}`, "--force-with-lease"]);
  const pr = await run("gh", [
    "pr", "create", "--repo", options.repo, "--base", options.base, "--head", branch,
    "--title", title, "--body", body,
  ]);

  return { opened: true, prUrl: pr.stdout.trim(), branch };
}
