import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { JazzbandError } from "./errors.js";
import type {
  AgentConfig,
  CodexConfig,
  HooksConfig,
  PollingConfig,
  RawConfig,
  ServiceConfig,
  TrackerConfig,
} from "./types.js";

type Env = Record<string, string | undefined>;

export interface ResolveConfigOptions {
  /** Directory containing the selected WORKFLOW.md; relative workspace roots resolve against it. */
  workflowDir: string;
  env?: Env;
  tempDir?: string;
}

/** A value that is exactly `$NAME` indirects through an environment variable (SPEC §6.1). */
const VAR_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

function fail(message: string): never {
  throw new JazzbandError("config_validation_error", message);
}

function asObject(value: unknown, field: string): RawConfig {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as RawConfig;
}

function resolveVar(value: string, env: Env): string | undefined {
  const match = VAR_PATTERN.exec(value);
  if (!match) return value;
  return env[match[1]!];
}

/** Resolve an optional secret value: literal or `$VAR`; empty/missing → null. */
function resolveSecret(value: unknown, env: Env, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value === "") return null;
  const resolved = resolveVar(value, env);
  return resolved && resolved !== "" ? resolved : null;
}

function coerceInt(value: unknown, field: string, positive = false): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    n = Number(value);
  } else {
    fail(`${field} must be an integer`);
  }
  if (!Number.isInteger(n)) fail(`${field} must be an integer`);
  if (positive && n <= 0) fail(`${field} must be a positive integer`);
  return n;
}

function optInt(value: unknown, field: string, fallback: number, positive = false): number {
  if (value === undefined || value === null) return fallback;
  return coerceInt(value, field, positive);
}

function optString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
}

function stringList(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined || value === null) return [...fallback];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${field} must be a list of strings`);
  }
  return [...(value as string[])];
}

function expandWorkspaceRoot(raw: unknown, env: Env, workflowDir: string, tempDir: string): string {
  if (raw === undefined || raw === null) return resolve(tempDir, "jazzband_workspaces");
  if (typeof raw !== "string") fail("workspace.root must be a path string");

  let value = raw;
  const varMatch = VAR_PATTERN.exec(value);
  if (varMatch) {
    const resolved = env[varMatch[1]!];
    if (resolved === undefined || resolved === "") {
      fail(`workspace.root references missing environment variable $${varMatch[1]}`);
    }
    value = resolved;
  }

  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = resolve(homedir(), value.slice(2));

  if (!isAbsolute(value)) value = resolve(workflowDir, value);
  return resolve(value);
}

function resolveTracker(raw: RawConfig, env: Env): TrackerConfig {
  const apiKey = resolveSecret(raw.api_key, env, "tracker.api_key");

  return {
    kind: optString(raw.kind, "tracker.kind") ?? "",
    endpoint: optString(raw.endpoint, "tracker.endpoint") ?? "https://api.linear.app/graphql",
    apiKey,
    projectSlug: optString(raw.project_slug, "tracker.project_slug"),
    activeStates: stringList(raw.active_states, "tracker.active_states", ["Todo", "In Progress"]),
    terminalStates: stringList(raw.terminal_states, "tracker.terminal_states", [
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]),
  };
}

function resolveAgent(raw: RawConfig): AgentConfig {
  const byState: Record<string, number> = {};
  const byStateRaw = raw.max_concurrent_agents_by_state;
  if (byStateRaw !== undefined && byStateRaw !== null) {
    const entries = asObject(byStateRaw, "agent.max_concurrent_agents_by_state");
    for (const [stateName, limit] of Object.entries(entries)) {
      const key = stateName.trim().toLowerCase();
      if (key === "") fail("agent.max_concurrent_agents_by_state has an empty state name");
      byState[key] = coerceInt(limit, `agent.max_concurrent_agents_by_state.${stateName}`, true);
    }
  }

  return {
    maxConcurrentAgents: optInt(raw.max_concurrent_agents, "agent.max_concurrent_agents", 10),
    maxTurns: optInt(raw.max_turns, "agent.max_turns", 20, true),
    maxRetryBackoffMs: optInt(raw.max_retry_backoff_ms, "agent.max_retry_backoff_ms", 300000),
    maxConcurrentAgentsByState: byState,
  };
}

function resolveCodex(raw: RawConfig): CodexConfig {
  return {
    command: optString(raw.command, "codex.command") ?? "codex app-server",
    approvalPolicy: optString(raw.approval_policy, "codex.approval_policy"),
    threadSandbox: optString(raw.thread_sandbox, "codex.thread_sandbox"),
    turnSandboxPolicy: optString(raw.turn_sandbox_policy, "codex.turn_sandbox_policy"),
    turnTimeoutMs: optInt(raw.turn_timeout_ms, "codex.turn_timeout_ms", 3600000),
    readTimeoutMs: optInt(raw.read_timeout_ms, "codex.read_timeout_ms", 5000),
    stallTimeoutMs: optInt(raw.stall_timeout_ms, "codex.stall_timeout_ms", 300000, true),
  };
}

function resolveDelivery(raw: RawConfig): ServiceConfig["delivery"] {
  const repo = optString(raw.repo, "delivery.repo");
  const remoteUrl = optString(raw.remote_url, "delivery.remote_url") ?? (repo ? `https://github.com/${repo}.git` : null);
  return { repo, remoteUrl };
}

function resolveClassifier(raw: RawConfig, env: Env): ServiceConfig["classifier"] {
  const runner = optString(raw.runner, "classifier.runner") ?? "api";
  if (runner !== "api" && runner !== "claude-cli") {
    fail(`classifier.runner must be "api" or "claude-cli"`);
  }
  return {
    runner,
    command: optString(raw.command, "classifier.command") ?? "claude",
    model: optString(raw.model, "classifier.model") ?? "claude-opus-4-8",
    apiKey: resolveSecret(raw.api_key, env, "classifier.api_key"),
    authToken: resolveSecret(raw.auth_token, env, "classifier.auth_token"),
  };
}

/**
 * Resolve a raw front-matter config map into the typed ServiceConfig (SPEC §6.1):
 * apply defaults, resolve `$VAR` indirection only where present, then coerce and validate.
 */
export function resolveConfig(rawConfig: RawConfig, options: ResolveConfigOptions): ServiceConfig {
  const env = options.env ?? process.env;
  const tempDir = options.tempDir ?? tmpdir();

  const trackerRaw = asObject(rawConfig.tracker, "tracker");
  const pollingRaw = asObject(rawConfig.polling, "polling");
  const workspaceRaw = asObject(rawConfig.workspace, "workspace");
  const hooksRaw = asObject(rawConfig.hooks, "hooks");
  const agentRaw = asObject(rawConfig.agent, "agent");
  const codexRaw = asObject(rawConfig.codex, "codex");
  const classifierRaw = asObject(rawConfig.classifier, "classifier");

  const polling: PollingConfig = {
    intervalMs: optInt(pollingRaw.interval_ms, "polling.interval_ms", 30000),
  };

  const hooks: HooksConfig = {
    afterCreate: optString(hooksRaw.after_create, "hooks.after_create"),
    beforeRun: optString(hooksRaw.before_run, "hooks.before_run"),
    afterRun: optString(hooksRaw.after_run, "hooks.after_run"),
    beforeRemove: optString(hooksRaw.before_remove, "hooks.before_remove"),
    timeoutMs: optInt(hooksRaw.timeout_ms, "hooks.timeout_ms", 60000),
  };

  return {
    tracker: resolveTracker(trackerRaw, env),
    polling,
    workspace: {
      root: expandWorkspaceRoot(workspaceRaw.root, env, options.workflowDir, tempDir),
      repo: resolveSecret(workspaceRaw.repo, env, "workspace.repo"),
      base: optString(workspaceRaw.base, "workspace.base") ?? "main",
    },
    hooks,
    agent: resolveAgent(agentRaw),
    codex: resolveCodex(codexRaw),
    classifier: resolveClassifier(classifierRaw, env),
    delivery: resolveDelivery(asObject(rawConfig.delivery, "delivery")),
  };
}

/**
 * Scheduler preflight run before dispatching new work (SPEC §6.3). Throws on the first failure.
 */
export function validateDispatchPreflight(config: ServiceConfig): void {
  if (!config.tracker.kind) fail("tracker.kind is required");
  if (config.tracker.kind !== "linear") fail(`unsupported tracker.kind: ${config.tracker.kind}`);
  if (!config.tracker.apiKey) fail("tracker.api_key is required (after $VAR resolution)");
  if (!config.tracker.projectSlug) {
    fail("tracker.project_slug is required when tracker.kind is linear");
  }
  if (config.codex.command.trim() === "") fail("codex.command must be present and non-empty");
}
