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
  /** PR body (the agent's evidence). Falls back to a minimal body when absent. */
  body?: string;
  /** Command run after the PR opens (with $PR_URL set), e.g. a code-review tool. Best-effort. */
  postPr?: string | null;
  /** Blast-radius + secret guardrails (defense in depth). */
  maxFiles?: number;
  maxDiffLines?: number;
  forbiddenPaths?: string[];
  secretScan?: boolean;
  exec?: Exec;
  timeoutMs?: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9-]{8,}/, // Anthropic keys/tokens
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, // private keys
];

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

  // Idempotency: never open a second PR for the same issue (SRE exactly-once).
  const existing = await exec(
    "gh",
    ["pr", "list", "--repo", options.repo, "--head", branch, "--state", "open", "--json", "url", "-q", ".[0].url"],
    at,
  );
  if (existing.code === 0 && existing.stdout.trim() !== "") {
    return { opened: false, reason: `PR already open: ${existing.stdout.trim()}` };
  }

  // Blast-radius + secret guardrails (defense in depth — don't trust the classifier alone).
  const changed = (await exec("git", ["diff", "--name-only", "HEAD"], at)).stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const forbidden = options.forbiddenPaths ?? [];
  const hit = changed.find((f) => forbidden.some((p) => f.includes(p)));
  if (hit) return { opened: false, reason: `blocked: change touches forbidden path (${hit})` };
  if (options.maxFiles && options.maxFiles > 0 && changed.length > options.maxFiles) {
    return { opened: false, reason: `blocked: ${changed.length} files changed exceeds max ${options.maxFiles}` };
  }
  const diff = await exec("git", ["diff", "HEAD"], at);
  if (options.maxDiffLines && options.maxDiffLines > 0) {
    const churn = diff.stdout.split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-]{3} /.test(l)).length;
    if (churn > options.maxDiffLines) {
      return { opened: false, reason: `blocked: diff of ${churn} lines exceeds max ${options.maxDiffLines}` };
    }
  }
  if (options.secretScan !== false) {
    const added = diff.stdout.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    if (added.some((l) => SECRET_PATTERNS.some((re) => re.test(l)))) {
      return { opened: false, reason: "blocked: the diff appears to contain a secret" };
    }
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
  const evidence = options.body?.trim() ? `${options.body.trim()}\n\n---\n` : "";
  const body = `${evidence}Fixes ${options.issue.url ?? options.issue.identifier}.\n\n🤖 Opened by Jazzband. Do not merge without review.`;

  await run("git", ["checkout", "-b", branch]);
  await run("git", ["add", "-A"]);
  await run("git", ["commit", "-m", title, "-m", body]);
  await run("git", ["remote", "add", REMOTE, options.remoteUrl], true); // ok if it already exists
  await run("git", ["push", REMOTE, `HEAD:${branch}`, "--force-with-lease"]);
  const pr = await run("gh", [
    "pr", "create", "--repo", options.repo, "--base", options.base, "--head", branch,
    "--title", title, "--body", body,
  ]);

  const prUrl = pr.stdout.trim();

  // Optional post-PR hook (code review / delivery verification), best-effort.
  if (options.postPr && options.postPr.trim() !== "") {
    await exec("bash", ["-lc", `PR_URL=${JSON.stringify(prUrl)} ${options.postPr}`], at).catch(() => undefined);
  }

  return { opened: true, prUrl, branch };
}
