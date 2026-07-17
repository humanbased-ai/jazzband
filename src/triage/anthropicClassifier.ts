import type { Issue } from "../core/types.js";
import type { Classification, Classifier } from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-8";

const GUIDE = `You are Usher, triaging a user-submitted bug report for the Humanbased product.
Classify it into exactly one verdict via the classify tool:
- fixable: a concrete code/config bug in our codebase, clear symptom, low-risk (does NOT touch auth, identity/KYC, payments, billing, secrets, migrations, infra, or data deletion).
- needs_confirmation: needs a product/design/policy decision, or too vague (no repro; unclear bug vs unbuilt feature; "options limited" = data-vs-code question).
- unimportant: praise, noise, test junk, or a pure cosmetic wish with no defect.
- dangerous: would require touching auth, identity/KYC, payments, billing, secrets, migrations, infra, or data deletion.
When unsure between fixable and anything else, do NOT pick fixable. provider_unavailable / third-party-outage / "temporarily unavailable" symptoms are dangerous or operational, never fixable.
Emit a short fingerprint (normalized symptom key) so duplicates collapse, a risk (critical|high|normal), a surface label (e.g. portal:webapp / portal:api, or "" if unknown), a fixArea (file/function when fixable, else ""), and a one-sentence reason.`;

const CLASSIFY_TOOL = {
  name: "classify",
  description: "Record the triage verdict for one bug report.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["fixable", "needs_confirmation", "unimportant", "dangerous"] },
      fingerprint: { type: "string" },
      risk: { type: "string", enum: ["critical", "high", "normal"] },
      surface: { type: "string" },
      fixArea: { type: "string" },
      reason: { type: "string" },
    },
    required: ["verdict", "fingerprint", "risk", "surface", "fixArea", "reason"],
  },
  strict: true,
};

interface MessageResponse {
  content: Array<{ type: string; name?: string; input?: unknown }>;
}

/** Seam over the Anthropic Messages API so the classifier is testable without a network call. */
export type RunMessage = (params: Record<string, unknown>) => Promise<MessageResponse>;

const defaultRunMessage: RunMessage = async (params) => {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  return client.messages.create(params as never) as unknown as Promise<MessageResponse>;
};

export interface AnthropicClassifierOptions {
  model?: string;
  runMessage?: RunMessage;
}

/** LLM-backed Classifier: one forced structured tool call per issue (SPEC-independent triage). */
export class AnthropicClassifier implements Classifier {
  private readonly model: string;
  private readonly runMessage: RunMessage;

  constructor(options: AnthropicClassifierOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.runMessage = options.runMessage ?? defaultRunMessage;
  }

  async classify(issue: Issue): Promise<Classification> {
    const response = await this.runMessage({
      model: this.model,
      max_tokens: 2048,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: "classify" },
      messages: [
        {
          role: "user",
          content: `${GUIDE}\n\nIssue ${issue.identifier}: ${issue.title}\n\n${issue.description ?? "(no description)"}`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === "tool_use" && b.name === "classify");
    if (!block || typeof block.input !== "object" || block.input === null) {
      throw new Error(`classifier returned no structured verdict for ${issue.identifier}`);
    }
    const fields = block.input as Omit<Classification, "issueId">;
    return { issueId: issue.id, ...fields };
  }
}
