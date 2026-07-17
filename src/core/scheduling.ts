import { normalizeState } from "./normalize.js";
import type { Issue } from "./types.js";

// Internal claim state of an issue (SPEC §7.1) — distinct from tracker states.
export type OrchestrationState = "unclaimed" | "claimed" | "running" | "retry_queued" | "released";

// Run-attempt lifecycle phases (SPEC §7.2).
export type RunPhase =
  | "preparing_workspace"
  | "building_prompt"
  | "launching_agent_process"
  | "initializing_session"
  | "streaming_turn"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stalled"
  | "canceled_by_reconciliation";

/** Short fixed delay for a continuation retry after a clean worker exit (SPEC §8.4). */
export const CONTINUATION_RETRY_DELAY_MS = 1000;

/** Exponential backoff for failure-driven retries (SPEC §8.4). `attempt` is 1-based. */
export function failureBackoffMs(attempt: number, maxBackoffMs: number): number {
  const base = 10000 * 2 ** (attempt - 1);
  return Math.min(base, maxBackoffMs);
}

export interface EligibilityContext {
  activeStates: string[];
  terminalStates: string[];
  running: ReadonlySet<string>;
  claimed: ReadonlySet<string>;
}

function hasRequiredFields(issue: Issue): boolean {
  return Boolean(issue.id && issue.identifier && issue.title && issue.state);
}

/** Candidate dispatch eligibility, excluding concurrency slots (SPEC §8.2). */
export function isDispatchEligible(issue: Issue, ctx: EligibilityContext): boolean {
  if (!hasRequiredFields(issue)) return false;

  const active = new Set(ctx.activeStates.map(normalizeState));
  const terminal = new Set(ctx.terminalStates.map(normalizeState));
  const state = normalizeState(issue.state);
  if (!active.has(state) || terminal.has(state)) return false;

  if (ctx.running.has(issue.id) || ctx.claimed.has(issue.id)) return false;

  // Todo blocker rule: do not dispatch while any blocker is non-terminal (SPEC §8.2).
  if (state === "todo") {
    for (const blocker of issue.blockedBy) {
      const blockerState = blocker.state ? normalizeState(blocker.state) : null;
      const blockerTerminal = blockerState !== null && terminal.has(blockerState);
      if (!blockerTerminal) return false;
    }
  }

  return true;
}

/** Dispatch ordering: priority asc (null last), then oldest createdAt, then identifier (SPEC §8.2). */
export function sortByDispatchPriority(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;

    const ca = a.createdAt ? Date.parse(a.createdAt) : Number.POSITIVE_INFINITY;
    const cb = b.createdAt ? Date.parse(b.createdAt) : Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;

    if (a.identifier < b.identifier) return -1;
    if (a.identifier > b.identifier) return 1;
    return 0;
  });
}

export interface DispatchLimits {
  maxConcurrentAgents: number;
  /** Normalized (lowercase) state keys → limit. */
  maxConcurrentAgentsByState: Record<string, number>;
}

/** Per-state concurrency limit, falling back to the global limit (SPEC §8.3). */
export function perStateLimit(state: string, limits: DispatchLimits): number {
  return limits.maxConcurrentAgentsByState[normalizeState(state)] ?? limits.maxConcurrentAgents;
}

export interface RunningCounts {
  total: number;
  /** Normalized (lowercase) state keys → running count. */
  byState: Record<string, number>;
}

/**
 * Choose which candidates to dispatch this tick: filter by eligibility, sort by dispatch
 * priority, then consume global and per-state concurrency slots in order (SPEC §8.2–8.3).
 */
export function selectDispatch(
  candidates: Issue[],
  ctx: EligibilityContext,
  limits: DispatchLimits,
  running: RunningCounts,
): Issue[] {
  const eligible = sortByDispatchPriority(candidates.filter((issue) => isDispatchEligible(issue, ctx)));
  const globalRemaining = Math.max(limits.maxConcurrentAgents - running.total, 0);

  const stateUsed: Record<string, number> = { ...running.byState };
  const selected: Issue[] = [];

  for (const issue of eligible) {
    if (selected.length >= globalRemaining) break;
    const key = normalizeState(issue.state);
    const used = stateUsed[key] ?? 0;
    if (used >= perStateLimit(issue.state, limits)) continue;
    selected.push(issue);
    stateUsed[key] = used + 1;
  }

  return selected;
}
