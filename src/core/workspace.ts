import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { workspaceKey } from "./normalize.js";

export type WorkspaceErrorCode =
  | "workspace_outside_root"
  | "workspace_not_a_directory"
  | "after_create_hook_failed";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export interface HookResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
}

/** A workspace shell hook (SPEC §9.4). Injected in tests. */
export type HookRunner = (
  script: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<HookResult>;

/** Default hook runner: `bash -lc <script>` with the workspace as cwd (SPEC §9.4). */
export const runShellHook: HookRunner = (script, { cwd, timeoutMs }) =>
  new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", script], { cwd, stdio: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ ok: false, code: null, timedOut });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({ ok: !timedOut && code === 0, code, timedOut });
    });
  });

/** Invariant 2 (SPEC §9.5): a workspace path MUST stay inside the workspace root. */
export function assertInsideRoot(root: string, target: string): void {
  const rel = relative(resolve(root), resolve(target));
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new WorkspaceError("workspace_outside_root", `${target} is outside workspace root ${root}`);
  }
}

/** Invariant 1 (SPEC §9.5): the coding agent runs only in its per-issue workspace. */
export function assertLaunchCwd(cwd: string, workspacePath: string): void {
  if (resolve(cwd) !== resolve(workspacePath)) {
    throw new WorkspaceError(
      "workspace_outside_root",
      `agent cwd ${cwd} must equal workspace path ${workspacePath}`,
    );
  }
}

/** Per-issue workspace path `<root>/<sanitized identifier>` (SPEC §9.1, §9.5 invariant 3). */
export function workspacePathFor(root: string, identifier: string): string {
  const path = resolve(root, workspaceKey(identifier));
  assertInsideRoot(root, path);
  return path;
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface PrepareWorkspaceOptions {
  root: string;
  identifier: string;
  afterCreate?: string | null;
  hookTimeoutMs: number;
  hookRunner?: HookRunner;
}

/**
 * Ensure the per-issue workspace exists (SPEC §9.2). `createdNow` is true only when this call
 * created the directory; on creation, the `after_create` hook runs and its failure is fatal —
 * the partially prepared directory is removed and an error thrown (SPEC §9.3, §9.4).
 */
export async function prepareWorkspace(options: PrepareWorkspaceOptions): Promise<Workspace> {
  const key = workspaceKey(options.identifier);
  const path = workspacePathFor(options.root, options.identifier);

  let createdNow = false;
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) {
      throw new WorkspaceError("workspace_not_a_directory", `${path} exists but is not a directory`);
    }
  } else {
    mkdirSync(path, { recursive: true });
    createdNow = true;
  }

  if (createdNow && options.afterCreate) {
    const runner = options.hookRunner ?? runShellHook;
    const result = await runner(options.afterCreate, { cwd: path, timeoutMs: options.hookTimeoutMs });
    if (!result.ok) {
      rmSync(path, { recursive: true, force: true });
      throw new WorkspaceError(
        "after_create_hook_failed",
        `after_create hook failed (code=${result.code}, timedOut=${result.timedOut})`,
      );
    }
  }

  return { path, workspaceKey: key, createdNow };
}

export interface RemoveWorkspaceOptions {
  root: string;
  path: string;
  beforeRemove?: string | null;
  hookTimeoutMs: number;
  hookRunner?: HookRunner;
}

/**
 * Remove a workspace directory (SPEC §9). Runs the `before_remove` hook first; its failure is
 * logged-and-ignored and cleanup proceeds regardless (SPEC §9.4).
 */
export async function removeWorkspace(options: RemoveWorkspaceOptions): Promise<void> {
  assertInsideRoot(options.root, options.path);
  if (!existsSync(options.path)) return;

  if (options.beforeRemove) {
    const runner = options.hookRunner ?? runShellHook;
    await runner(options.beforeRemove, { cwd: options.path, timeoutMs: options.hookTimeoutMs });
  }
  rmSync(options.path, { recursive: true, force: true });
}
