import { validateDispatchPreflight } from "../core/config.js";
import { planTick, runningCountsByState } from "../core/tick.js";
import type { Issue, ServiceConfig } from "../core/types.js";

/** Just the tracker read the loop needs; keeps the loop testable without a live client. */
export interface CandidateSource {
  fetchCandidateIssues(): Promise<Issue[]>;
}

/** Launch a worker for a dispatched issue. The concrete agent launch lands with AppServerClient. */
export type Dispatcher = (issue: Issue) => void | Promise<void>;

export interface RuntimeDeps {
  config: ServiceConfig;
  source: CandidateSource;
  dispatch: Dispatcher;
  log?: (message: string) => void;
}

export interface RuntimeState {
  running: Set<string>;
  claimed: Set<string>;
  /** issue id → tracked state, for per-state concurrency accounting. */
  runningStates: Map<string, string>;
}

export function newRuntimeState(): RuntimeState {
  return { running: new Set(), claimed: new Set(), runningStates: new Map() };
}

export interface TickResult {
  dispatched: Issue[];
  skipped: boolean;
}

/**
 * One poll tick (SPEC §8.1): preflight, fetch candidates, plan dispatch under concurrency, and
 * dispatch. On preflight or fetch failure, skip dispatch for this tick (reconciliation would still
 * run once the live worker layer exists). Claimed issues are not re-dispatched (SPEC §7.4).
 */
export async function tick(deps: RuntimeDeps, state: RuntimeState): Promise<TickResult> {
  const log = deps.log ?? (() => {});

  try {
    validateDispatchPreflight(deps.config);
  } catch (error) {
    log(`preflight failed, skipping dispatch: ${(error as Error).message}`);
    return { dispatched: [], skipped: true };
  }

  let candidates: Issue[];
  try {
    candidates = await deps.source.fetchCandidateIssues();
  } catch (error) {
    log(`candidate fetch failed, skipping dispatch: ${(error as Error).message}`);
    return { dispatched: [], skipped: true };
  }

  const plan = planTick({
    candidates,
    config: deps.config,
    running: state.running,
    claimed: state.claimed,
    runningCounts: runningCountsByState([...state.runningStates.values()]),
  });

  for (const issue of plan.dispatch) {
    state.claimed.add(issue.id);
    state.running.add(issue.id);
    state.runningStates.set(issue.id, issue.state);
    await deps.dispatch(issue);
  }

  log(`tick: ${candidates.length} candidates, dispatched ${plan.dispatch.length}`);
  return { dispatched: plan.dispatch, skipped: false };
}

export interface RunLoopOptions {
  once?: boolean;
  /** Injectable scheduler seam (defaults to setInterval) for testing the repeat path. */
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Run the poll loop: an immediate tick, then repeat every `polling.interval_ms` (SPEC §8.1).
 * With `once`, run a single tick and return.
 */
export async function runLoop(deps: RuntimeDeps, options: RunLoopOptions = {}): Promise<RuntimeState> {
  const state = newRuntimeState();
  await tick(deps, state);
  if (options.once) return state;

  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms));
  schedule(() => {
    void tick(deps, state);
  }, deps.config.polling.intervalMs);
  return state;
}
