import { normalizeState } from "./normalize.js";
import { selectDispatch, type EligibilityContext, type RunningCounts } from "./scheduling.js";
import type { Issue, ServiceConfig } from "./types.js";

export interface TickInput {
  candidates: Issue[];
  config: ServiceConfig;
  running: ReadonlySet<string>;
  claimed: ReadonlySet<string>;
  runningCounts: RunningCounts;
}

export interface TickPlan {
  dispatch: Issue[];
}

/**
 * Plan one poll tick's dispatch decisions (SPEC §8.1 steps 3–5): from the fetched candidates and
 * current running/claimed state, choose which issues to dispatch under the config's concurrency
 * limits. Reconciliation and side effects (timers, workers) are driven by the live runtime.
 */
export function planTick(input: TickInput): TickPlan {
  const ctx: EligibilityContext = {
    activeStates: input.config.tracker.activeStates,
    terminalStates: input.config.tracker.terminalStates,
    running: input.running,
    claimed: input.claimed,
  };

  const dispatch = selectDispatch(
    input.candidates,
    ctx,
    {
      maxConcurrentAgents: input.config.agent.maxConcurrentAgents,
      maxConcurrentAgentsByState: input.config.agent.maxConcurrentAgentsByState,
    },
    input.runningCounts,
  );

  return { dispatch };
}

/** Tally running issues by their normalized state for per-state concurrency accounting (§8.3). */
export function runningCountsByState(runningStates: string[]): RunningCounts {
  const byState: Record<string, number> = {};
  for (const state of runningStates) {
    const key = normalizeState(state);
    byState[key] = (byState[key] ?? 0) + 1;
  }
  return { total: runningStates.length, byState };
}
