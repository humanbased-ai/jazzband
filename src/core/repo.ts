import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface GitResult {
  code: number | null;
  stderr: string;
}

/** Runs a git command in `cwd`. Injectable so workspace population is testable without real git. */
export type GitRunner = (args: string[], options: { cwd: string; timeoutMs: number }) => Promise<GitResult>;

export const defaultGit: GitRunner = (args, { cwd, timeoutMs }) =>
  new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr: timedOut ? `${stderr}\n(timed out)` : stderr });
    });
  });

export class RepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

export interface PopulateOptions {
  path: string;
  repo: string;
  base: string;
  runner?: GitRunner;
  timeoutMs?: number;
}

/**
 * Check out `repo`@`base` into the (already-created) workspace directory. A fresh workspace is
 * shallow-cloned; a reused one is fetched and hard-reset to the remote base and cleaned, so each
 * run starts from a pristine tree without re-cloning.
 */
export async function populateWorkspace(options: PopulateOptions): Promise<void> {
  const git = options.runner ?? defaultGit;
  const timeoutMs = options.timeoutMs ?? 300000;
  const at = { cwd: options.path, timeoutMs };

  const steps: string[][] = existsSync(join(options.path, ".git"))
    ? [
        ["fetch", "--depth", "1", "origin", options.base],
        ["checkout", "-f", options.base],
        ["reset", "--hard", `origin/${options.base}`],
        ["clean", "-fd"],
      ]
    : [["clone", "--depth", "1", "--branch", options.base, options.repo, "."]];

  for (const args of steps) {
    const result = await git(args, at);
    if (result.code !== 0) {
      throw new RepoError(`git ${args[0]} failed (code=${result.code}): ${result.stderr.trim().slice(0, 300)}`);
    }
  }
}
