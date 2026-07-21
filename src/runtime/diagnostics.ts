import { tmpdir } from "node:os";
import { JazzbandError } from "../core/errors.js";
import type { Issue, ServiceConfig } from "../core/types.js";
import { spawnClaude, type SpawnAgent } from "../agent/claudeClient.js";
import { AnthropicClassifier } from "../triage/anthropicClassifier.js";
import { ClaudeCliClassifier } from "../triage/claudeCliClassifier.js";
import type { Classifier } from "../triage/types.js";

export type AuthEnv = Record<string, string | undefined>;

/** Probe whether the `claude` CLI is authenticated for headless use. */
export async function probeClaudeLoggedIn(command: string, spawnAgent: SpawnAgent = spawnClaude): Promise<boolean> {
  try {
    const r = await spawnAgent(command, ["-p", "ok", "--output-format", "json"], { cwd: tmpdir(), timeoutMs: 60000 });
    if (r.code !== 0) return false;
    const body = JSON.parse(r.stdout) as { is_error?: boolean; result?: string };
    if (body.is_error) return false;
    return !/not logged in/i.test(body.result ?? "");
  } catch {
    return false;
  }
}

export interface ClassifierChoice {
  classifier: Classifier;
  backend: string;
}

/**
 * Pick the classifier backend with graceful degradation:
 * explicit config key/token → then a logged-in `claude` CLI → then env ANTHROPIC_API_KEY /
 * CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN. If nothing works, throw with clear guidance.
 */
export function chooseClassifier(
  config: ServiceConfig,
  opts: { claudeLoggedIn: boolean; env: AuthEnv; onCost?: (usd: number | undefined) => void },
): ClassifierChoice {
  const { env, onCost } = opts;
  const model = config.classifier.model;
  const command = config.classifier.command;
  const cli = () => new ClaudeCliClassifier({ command, model, onCost });

  if (config.classifier.apiKey) {
    return { classifier: new AnthropicClassifier({ model, apiKey: config.classifier.apiKey }), backend: "api-key (config)" };
  }
  if (config.classifier.authToken) {
    return { classifier: new AnthropicClassifier({ model, authToken: config.classifier.authToken }), backend: "auth-token (config)" };
  }
  if (config.classifier.runner === "api") {
    if (env.ANTHROPIC_API_KEY) return { classifier: new AnthropicClassifier({ model }), backend: "api-key (env)" };
    throw noAuthError();
  }

  // Default runner "claude-cli": prefer the logged-in CLI, then degrade to env credentials.
  if (opts.claudeLoggedIn) return { classifier: cli(), backend: "claude-cli (logged in)" };
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return { classifier: cli(), backend: "claude-cli (CLAUDE_CODE_OAUTH_TOKEN)" };
  if (env.ANTHROPIC_API_KEY) return { classifier: new AnthropicClassifier({ model }), backend: "api-key (env, claude not logged in)" };
  if (env.ANTHROPIC_AUTH_TOKEN) return { classifier: new AnthropicClassifier({ model, authToken: env.ANTHROPIC_AUTH_TOKEN }), backend: "auth-token (env)" };
  throw noAuthError();
}

function noAuthError(): JazzbandError {
  return new JazzbandError(
    "config_validation_error",
    "No usable Claude auth. Do ONE of: (a) run `claude` and log in (subscription), " +
      "(b) export ANTHROPIC_API_KEY, (c) export CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), " +
      "or (d) set classifier.api_key in the workflow.",
  );
}

export interface AutoStates {
  states: string[];
  issues: Issue[];
  widened: boolean;
}

const COMMON_STATES = ["Backlog", "Todo", "In Progress"];

/**
 * Fetch candidates for the configured states; if none, widen to the common set once and retry —
 * so a bug board that lives in Backlog isn't silently empty when the default states are used.
 */
export async function fetchWithAutoStates(
  fetch: (states: string[]) => Promise<Issue[]>,
  configured: string[],
): Promise<AutoStates> {
  const issues = await fetch(configured);
  if (issues.length > 0) return { states: configured, issues, widened: false };

  const widened = [...new Set([...configured, ...COMMON_STATES])];
  if (widened.length === configured.length) return { states: configured, issues, widened: false };
  const retry = await fetch(widened);
  return { states: widened, issues: retry, widened: retry.length > 0 };
}
