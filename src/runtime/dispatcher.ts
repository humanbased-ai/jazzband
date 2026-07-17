import { renderPrompt } from "../core/prompt.js";
import { prepareWorkspace } from "../core/workspace.js";
import type { Issue, ServiceConfig } from "../core/types.js";
import { runAttempt, type AppServerClient, type AttemptOutcome } from "../agent/runner.js";
import type { EventSink } from "../agent/events.js";
import type { Dispatcher } from "./loop.js";

export interface DispatcherDeps {
  config: ServiceConfig;
  /** WORKFLOW.md prompt body (rendered per issue). */
  promptTemplate: string;
  /** Build the coding-agent client for an issue (default: ClaudeAgentClient). */
  makeClient: (issue: Issue) => AppServerClient;
  onEvent?: EventSink;
  onOutcome?: (issue: Issue, outcome: AttemptOutcome) => void;
}

/**
 * A Dispatcher that runs a real coding agent per issue (SPEC §10.7): prepare the per-issue
 * workspace, render the prompt, then drive the agent client through runAttempt. Errors from one
 * issue don't abort the tick — the loop keeps its claim and the orchestrator retries later.
 */
export function makeAgentDispatcher(deps: DispatcherDeps): Dispatcher {
  return async (issue: Issue) => {
    const workspace = await prepareWorkspace({
      root: deps.config.workspace.root,
      identifier: issue.identifier,
      afterCreate: deps.config.hooks.afterCreate,
      hookTimeoutMs: deps.config.hooks.timeoutMs,
    });

    const prompt = renderPrompt(deps.promptTemplate, { issue });

    const outcome = await runAttempt({
      issue,
      prompt,
      workspacePath: workspace.path,
      cwd: workspace.path,
      client: deps.makeClient(issue),
      onEvent: deps.onEvent ?? (() => {}),
      maxTurns: deps.config.agent.maxTurns,
    });

    deps.onOutcome?.(issue, outcome);
  };
}
