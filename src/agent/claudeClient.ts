import { spawn } from "node:child_process";
import type { Issue } from "../core/types.js";
import type { AppServerClient, StartResult } from "./runner.js";
import type { TurnSignal } from "./turn.js";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Subprocess seam so the Claude launch is testable without the real `claude` binary. */
export type SpawnAgent = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<SpawnResult>;

export const spawnClaude: SpawnAgent = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, timedOut });
    });
  });

export interface ClaudeAgentOptions {
  command?: string;
  model?: string;
  /** Permission posture for autonomous file edits; see `claude --help`. */
  permissionMode?: string;
  turnTimeoutMs?: number;
  spawnAgent?: SpawnAgent;
}

interface ClaudeResult {
  is_error?: boolean;
  session_id?: string;
  subtype?: string;
  result?: string;
}

/**
 * Runs the delivery coding agent as headless Claude Code (`claude -p … --output-format json`) in
 * the per-issue workspace — the Claude equivalent of the Codex app-server client. The first turn
 * sends the full prompt; continuation turns `--resume` the captured session on the same workspace.
 */
export class ClaudeAgentClient implements AppServerClient {
  private readonly command: string;
  private readonly model: string;
  private readonly permissionMode: string;
  private readonly turnTimeoutMs: number;
  private readonly spawnAgent: SpawnAgent;
  private cwd = "";
  private sessionId: string | null = null;
  private lastSummary = "";

  constructor(options: ClaudeAgentOptions = {}) {
    this.command = options.command ?? "claude";
    this.model = options.model ?? "claude-opus-4-8";
    this.permissionMode = options.permissionMode ?? "acceptEdits";
    this.turnTimeoutMs = options.turnTimeoutMs ?? 3600000;
    this.spawnAgent = options.spawnAgent ?? spawnClaude;
  }

  async start(options: { cwd: string; issue: Issue }): Promise<StartResult> {
    this.cwd = options.cwd;
    this.sessionId = null;
    return { threadId: options.issue.identifier, pid: null };
  }

  async runTurn(options: { prompt: string; continuation: boolean }): Promise<TurnSignal> {
    const args = ["-p", options.prompt, "--output-format", "json", "--model", this.model, "--permission-mode", this.permissionMode];
    if (options.continuation && this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const result = await this.spawnAgent(this.command, args, { cwd: this.cwd, timeoutMs: this.turnTimeoutMs });
    if (result.timedOut) return "timeout";
    if (result.code === null) return "subprocess_exit";

    let parsed: ClaudeResult | null = null;
    try {
      parsed = JSON.parse(result.stdout) as ClaudeResult;
    } catch {
      parsed = null;
    }
    if (parsed?.session_id) this.sessionId = parsed.session_id;
    if (typeof parsed?.result === "string" && parsed.result.trim() !== "") this.lastSummary = parsed.result;

    if (result.code !== 0) return "failed";
    if (parsed?.is_error) return "failed";
    return "completed";
  }

  /** The agent's final message from the last turn — used as the PR body (its own evidence). */
  summary(): string | undefined {
    return this.lastSummary.trim() === "" ? undefined : this.lastSummary;
  }

  async stop(): Promise<void> {
    // Headless Claude Code has no long-lived process to stop.
  }
}
