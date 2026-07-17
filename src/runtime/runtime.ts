import { validateDispatchPreflight } from "../core/config.js";
import { normalizeState } from "../core/normalize.js";
import { failureBackoffMs, selectDispatch, type EligibilityContext } from "../core/scheduling.js";
import { runningCountsByState } from "../core/tick.js";
import type { Issue, ServiceConfig } from "../core/types.js";

export interface RuntimeSource {
  fetchCandidateIssues(): Promise<Issue[]>;
  /** Used to reconcile the state of currently-running issues (SPEC §8.5). */
  fetchIssueStatesByIds?(ids: string[]): Promise<Issue[]>;
}

/** Runs one issue to a settled outcome (prepare workspace → agent → PR). */
export type Worker = (issue: Issue) => Promise<{ ok: boolean }>;

export interface RuntimeDeps {
  config: ServiceConfig;
  source: RuntimeSource;
  worker: Worker;
  now: () => number;
  /** Which candidates jazzband should actually work. Default: those labeled `triage:fixable`. */
  selectWorkable?: (issues: Issue[]) => Issue[];
  log?: (message: string) => void;
}

const defaultWorkable = (issues: Issue[]): Issue[] =>
  issues.filter((issue) => issue.labels.includes("triage:fixable"));

/**
 * The delivery runtime: each tick reconciles running issues, dispatches workers for eligible
 * `triage:fixable` candidates under concurrency, and manages claim/retry lifecycle. A worker that
 * fails schedules a backoff retry (poll-gated, no separate timers); a worker that succeeds releases
 * the claim so the next poll re-evaluates the (possibly now-terminal) issue.
 */
export class Runtime {
  private readonly running = new Set<string>();
  private readonly claimed = new Set<string>();
  private readonly runningStates = new Map<string, string>();
  private readonly retryAt = new Map<string, number>();
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: RuntimeDeps) {}

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private async reconcile(): Promise<void> {
    const refresh = this.deps.source.fetchIssueStatesByIds;
    if (!refresh || this.running.size === 0) return;

    let refreshed: Issue[];
    try {
      refreshed = await refresh.call(this.deps.source, [...this.running]);
    } catch (error) {
      this.log(`reconcile failed, keeping workers running: ${(error as Error).message}`);
      return;
    }

    const active = new Set(this.deps.config.tracker.activeStates.map(normalizeState));
    for (const issue of refreshed) {
      if (!this.running.has(issue.id)) continue;
      if (!active.has(normalizeState(issue.state))) {
        // Terminal or no longer active: the run is done as far as the poller is concerned.
        this.release(issue.id);
      } else {
        this.runningStates.set(issue.id, issue.state);
      }
    }
  }

  private release(id: string): void {
    this.running.delete(id);
    this.claimed.delete(id);
    this.runningStates.delete(id);
  }

  private onSettle(issue: Issue, ok: boolean): void {
    this.running.delete(issue.id);
    this.runningStates.delete(issue.id);
    if (ok) {
      this.claimed.delete(issue.id);
      this.attempts.delete(issue.id);
      this.retryAt.delete(issue.id);
      return;
    }
    const attempt = (this.attempts.get(issue.id) ?? 0) + 1;
    this.attempts.set(issue.id, attempt);
    this.retryAt.set(issue.id, this.deps.now() + failureBackoffMs(attempt, this.deps.config.agent.maxRetryBackoffMs));
    this.claimed.delete(issue.id); // released, but retry-gated until backoff elapses
    this.log(`worker failed for ${issue.identifier}, retry #${attempt} scheduled`);
  }

  /** Which issues this tick would dispatch, without launching workers (for dry-run/tests). */
  planDispatch(candidates: Issue[]): Issue[] {
    const now = this.deps.now();
    const workable = (this.deps.selectWorkable ?? defaultWorkable)(candidates).filter(
      (issue) => (this.retryAt.get(issue.id) ?? 0) <= now,
    );
    const ctx: EligibilityContext = {
      activeStates: this.deps.config.tracker.activeStates,
      terminalStates: this.deps.config.tracker.terminalStates,
      running: this.running,
      claimed: this.claimed,
    };
    return selectDispatch(
      workable,
      ctx,
      {
        maxConcurrentAgents: this.deps.config.agent.maxConcurrentAgents,
        maxConcurrentAgentsByState: this.deps.config.agent.maxConcurrentAgentsByState,
      },
      runningCountsByState([...this.runningStates.values()]),
    );
  }

  /** Run one poll tick; returns the in-flight worker promises so callers can await them. */
  async tick(): Promise<Promise<void>[]> {
    await this.reconcile();

    try {
      validateDispatchPreflight(this.deps.config);
    } catch (error) {
      this.log(`preflight failed, skipping dispatch: ${(error as Error).message}`);
      return [];
    }

    let candidates: Issue[];
    try {
      candidates = await this.deps.source.fetchCandidateIssues();
    } catch (error) {
      this.log(`candidate fetch failed, skipping dispatch: ${(error as Error).message}`);
      return [];
    }

    const workers: Promise<void>[] = [];
    for (const issue of this.planDispatch(candidates)) {
      this.claimed.add(issue.id);
      this.running.add(issue.id);
      this.runningStates.set(issue.id, issue.state);
      workers.push(
        this.deps
          .worker(issue)
          .then((result) => this.onSettle(issue, result.ok))
          .catch(() => this.onSettle(issue, false)),
      );
    }
    this.log(`tick: ${candidates.length} candidates, dispatched ${workers.length}`);
    return workers;
  }
}

export interface RunOptions {
  once?: boolean;
  schedule?: (fn: () => void, ms: number) => void;
}

/** Immediate tick then repeat every polling.interval_ms; `once` runs a single tick and awaits it. */
export async function run(deps: RuntimeDeps, options: RunOptions = {}): Promise<Runtime> {
  const runtime = new Runtime(deps);
  const workers = await runtime.tick();
  if (options.once) {
    await Promise.all(workers);
    return runtime;
  }
  const schedule = options.schedule ?? ((fn, ms) => setInterval(fn, ms));
  schedule(() => {
    void runtime.tick();
  }, deps.config.polling.intervalMs);
  return runtime;
}
