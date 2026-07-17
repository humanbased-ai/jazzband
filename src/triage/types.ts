import type { Issue } from "../core/types.js";

/** Triage verdict for a user-submitted bug report. `duplicate` is assigned by de-dup, not the classifier. */
export type Verdict = "fixable" | "duplicate" | "needs_confirmation" | "unimportant" | "dangerous";

export type Risk = "critical" | "high" | "normal";

/** Per-issue classification produced by the LLM classifier (the classifier never returns `duplicate`). */
export interface Classification {
  issueId: string;
  verdict: Exclude<Verdict, "duplicate">;
  /** Normalized symptom key used to collapse duplicates. */
  fingerprint: string;
  risk: Risk;
  /** Surface label such as `portal:webapp`, or "" when unknown. */
  surface: string;
  /** Plausible fix area when fixable; "" otherwise. */
  fixArea: string;
  reason: string;
}

/** The LLM classification seam. The concrete Anthropic-backed implementation is wired separately. */
export interface Classifier {
  classify(issue: Issue): Promise<Classification>;
}

/** What triage decided to do with one issue. */
export interface TriageDecision {
  issue: Issue;
  verdict: Verdict;
  labels: string[];
  /** Canonical issue identifier when this one is a duplicate; null otherwise. */
  duplicateOf: string | null;
  /** Only safe, non-duplicate, fixable issues are promoted into the delivery loop. */
  promote: boolean;
  reason: string;
}

export interface TriagePlan {
  decisions: TriageDecision[];
}
