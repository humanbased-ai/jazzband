import { tmpdir } from "node:os";
import { spawnClaude, type SpawnAgent } from "../agent/claudeClient.js";
import type { Issue } from "../core/types.js";
import type { Classification, VerifyResult, Verifier } from "./types.js";

const GUIDE = `You are an ADVERSARIAL reviewer. A triage step wants to AUTO-FIX this bug with a coding agent that opens a PR. Argue whether that is actually safe and correct.
Say NOT safe (safe=false) if ANY hold: the fix would touch the WRONG control (the classifier's fixArea does not match the exact thing the user reported — e.g. an Enroll button when the user said "watch"), it needs a product/design decision, it's under-specified (no clear repro), it's out of scope for the owning code, or it risks auth/identity/payments/billing/secrets/migrations/infra/data.
Default to safe=false when in doubt. Respond with ONLY JSON: {"safe": true|false, "reason": "one sentence"}`;

function extractJson(text: string): Record<string, unknown> {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("verifier output had no JSON");
  return JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
}

export interface ClaudeCliVerifierOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
  spawnAgent?: SpawnAgent;
  onCost?: (usd: number | undefined) => void;
}

/** Adversarial verifier over the logged-in `claude` CLI. On any error, fail safe (safe=false). */
export class ClaudeCliVerifier implements Verifier {
  private readonly command: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly spawnAgent: SpawnAgent;
  private readonly onCost?: (usd: number | undefined) => void;

  constructor(options: ClaudeCliVerifierOptions = {}) {
    this.command = options.command ?? "claude";
    this.model = options.model ?? "claude-opus-4-8";
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.spawnAgent = options.spawnAgent ?? spawnClaude;
    this.onCost = options.onCost;
  }

  async verify(issue: Issue, classification: Classification): Promise<VerifyResult> {
    const prompt = `${GUIDE}\n\nBug ${issue.identifier}: ${issue.title}\n${issue.description ?? ""}\n\nClassifier said fixable. fixArea: ${classification.fixArea || "(none)"}. surface: ${classification.surface || "(none)"}.`;
    try {
      const result = await this.spawnAgent(
        this.command,
        ["-p", prompt, "--output-format", "json", "--model", this.model],
        { cwd: tmpdir(), timeoutMs: this.timeoutMs },
      );
      if (result.timedOut || result.code !== 0) return { safe: false, reason: "verifier run failed" };
      const envelope = JSON.parse(result.stdout) as { is_error?: boolean; result?: string; total_cost_usd?: number };
      this.onCost?.(envelope.total_cost_usd);
      if (envelope.is_error || typeof envelope.result !== "string") return { safe: false, reason: "verifier returned an error" };
      const fields = extractJson(envelope.result);
      return { safe: fields.safe === true, reason: String(fields.reason ?? "") };
    } catch (error) {
      return { safe: false, reason: `verifier error: ${(error as Error).message}` };
    }
  }
}
