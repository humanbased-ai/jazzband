import { assertLaunchCwd } from "../core/workspace.js";
import type { Issue } from "../core/types.js";
import { AgentError } from "./errors.js";
import { makeEvent, type EventSink } from "./events.js";
import { classifyTurn, turnErrorCode, turnEventName, type TurnSignal } from "./turn.js";

export interface StartResult {
  threadId: string;
  pid: string | null;
}

/**
 * The app-server client the runner drives. The concrete Codex stdio JSON-RPC implementation is a
 * protocol-version-specific follow-up; the runner only depends on this contract (SPEC §10.1–10.3).
 */
export interface AppServerClient {
  start(options: { cwd: string; issue: Issue }): Promise<StartResult>;
  runTurn(options: { prompt: string; continuation: boolean; threadId: string }): Promise<TurnSignal>;
  stop(): Promise<void>;
}

export interface RunAttemptContext {
  issue: Issue;
  /** Rendered first-turn prompt (prompt engine is a later slice). */
  prompt: string;
  /** Continuation-turn guidance; not the original prompt (SPEC §10.2). */
  continuationPrompt?: string;
  workspacePath: string;
  cwd: string;
  client: AppServerClient;
  onEvent: EventSink;
  maxTurns: number;
  /** Orchestrator decides whether to run another continuation turn on the live thread (SPEC §7). */
  shouldContinue?: (turnsCompleted: number) => boolean | Promise<boolean>;
  now?: () => string;
}

export interface AttemptOutcome {
  ok: boolean;
  turns: number;
  threadId: string | null;
  error: AgentError | null;
}

const DEFAULT_CONTINUATION = "Continue working on the issue.";

/**
 * Agent Runner contract (SPEC §10.7): start the session in the per-issue workspace, run turns on
 * one live thread up to `maxTurns` (continuing only while the orchestrator says so), forward every
 * event upstream, and stop the subprocess when the run ends. Any error fails the attempt.
 */
export async function runAttempt(ctx: RunAttemptContext): Promise<AttemptOutcome> {
  const now = ctx.now;
  assertLaunchCwd(ctx.cwd, ctx.workspacePath); // Invariant 1 (SPEC §9.5)

  let start: StartResult;
  try {
    start = await ctx.client.start({ cwd: ctx.cwd, issue: ctx.issue });
  } catch (error) {
    ctx.onEvent(makeEvent("startup_failed", { now, payload: { message: (error as Error).message } }));
    return { ok: false, turns: 0, threadId: null, error: new AgentError("port_exit", (error as Error).message) };
  }
  ctx.onEvent(makeEvent("session_started", { pid: start.pid, now, payload: { threadId: start.threadId } }));

  let turns = 0;
  try {
    for (;;) {
      const continuation = turns > 0;
      const signal = await ctx.client.runTurn({
        prompt: continuation ? (ctx.continuationPrompt ?? DEFAULT_CONTINUATION) : ctx.prompt,
        continuation,
        threadId: start.threadId,
      });
      ctx.onEvent(makeEvent(turnEventName(signal), { pid: start.pid, now }));

      if (!classifyTurn(signal).ok) {
        return {
          ok: false,
          turns,
          threadId: start.threadId,
          error: new AgentError(turnErrorCode(signal as Exclude<TurnSignal, "completed">), `turn ${signal}`),
        };
      }

      turns += 1;
      if (turns >= ctx.maxTurns) break;
      const cont = ctx.shouldContinue ? await ctx.shouldContinue(turns) : false;
      if (!cont) break;
    }
    return { ok: true, turns, threadId: start.threadId, error: null };
  } finally {
    await ctx.client.stop();
  }
}
