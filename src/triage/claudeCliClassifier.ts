import { tmpdir } from "node:os";
import type { Issue } from "../core/types.js";
import { type SpawnAgent } from "../agent/claudeClient.js";
import { spawnClaude } from "../agent/claudeClient.js";
import type { Classification, Classifier, Risk } from "./types.js";

const VERDICTS = new Set(["fixable", "needs_confirmation", "unimportant", "dangerous"]);
const RISKS = new Set(["critical", "high", "normal"]);

const GUIDE = `You are Usher, triaging one user-submitted bug report for the Humanbased product.
Classify it into exactly one verdict:
- fixable: a concrete code/config bug in our codebase, clear symptom, low-risk (does NOT touch auth, identity/KYC, payments, billing, secrets, migrations, infra, or data deletion).
- needs_confirmation: needs a product/design/policy decision, or too vague (no repro; unclear bug vs unbuilt feature; "options limited" = data-vs-code question).
- unimportant: praise, noise, test junk, or a pure cosmetic wish with no defect.
- dangerous: would require touching auth, identity/KYC, payments, billing, secrets, migrations, infra, or data deletion.
When unsure between fixable and anything else, do NOT pick fixable. provider_unavailable / third-party-outage / "temporarily unavailable" symptoms are dangerous or operational, never fixable.
Pin the EXACT control the user names — match their wording. A "watch button" is the Watch/Follow control, NOT a nearby Enroll/Join button; "watch" and "enroll" are different actions. When fixable, fixArea MUST name the specific component/file that renders THAT control.

Respond with ONLY a JSON object, no prose and no code fences:
{"verdict":"fixable|needs_confirmation|unimportant|dangerous","fingerprint":"short normalized symptom key","risk":"critical|high|normal","surface":"e.g. portal:webapp or empty string","fixArea":"file/function if fixable else empty string","reason":"one sentence"}`;

/** Pull the first JSON object out of a text blob (tolerates code fences / surrounding prose). */
function extractJson(text: string): Record<string, unknown> {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("classifier output contained no JSON object");
  }
  return JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
}

export interface ClaudeCliClassifierOptions {
  command?: string;
  model?: string;
  timeoutMs?: number;
  spawnAgent?: SpawnAgent;
  /** Reports the USD cost of each classify call (from the CLI's total_cost_usd). */
  onCost?: (usd: number | undefined) => void;
}

/**
 * Classifier that shells out to the logged-in `claude` CLI (`claude -p … --output-format json`),
 * reusing the operator's Claude subscription/OAuth login — no ANTHROPIC_API_KEY required.
 */
export class ClaudeCliClassifier implements Classifier {
  private readonly command: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly spawnAgent: SpawnAgent;
  private readonly onCost?: (usd: number | undefined) => void;

  constructor(options: ClaudeCliClassifierOptions = {}) {
    this.command = options.command ?? "claude";
    this.model = options.model ?? "claude-opus-4-8";
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.spawnAgent = options.spawnAgent ?? spawnClaude;
    this.onCost = options.onCost;
  }

  async classify(issue: Issue): Promise<Classification> {
    const prompt = `${GUIDE}\n\nIssue ${issue.identifier}: ${issue.title}\n\n${issue.description ?? "(no description)"}`;
    const result = await this.spawnAgent(
      this.command,
      ["-p", prompt, "--output-format", "json", "--model", this.model],
      { cwd: tmpdir(), timeoutMs: this.timeoutMs },
    );
    if (result.timedOut || result.code !== 0) {
      throw new Error(`claude CLI classify failed for ${issue.identifier} (code=${result.code}, timedOut=${result.timedOut})`);
    }

    const envelope = JSON.parse(result.stdout) as { is_error?: boolean; result?: string; total_cost_usd?: number };
    this.onCost?.(envelope.total_cost_usd);
    if (envelope.is_error || typeof envelope.result !== "string") {
      throw new Error(`claude CLI returned an error for ${issue.identifier}`);
    }

    const fields = extractJson(envelope.result);
    const verdict = String(fields.verdict);
    const risk = String(fields.risk);
    if (!VERDICTS.has(verdict)) throw new Error(`invalid verdict "${verdict}" for ${issue.identifier}`);

    return {
      issueId: issue.id,
      verdict: verdict as Classification["verdict"],
      fingerprint: String(fields.fingerprint ?? issue.id),
      risk: (RISKS.has(risk) ? risk : "normal") as Risk,
      surface: String(fields.surface ?? ""),
      fixArea: String(fields.fixArea ?? ""),
      reason: String(fields.reason ?? ""),
    };
  }
}
