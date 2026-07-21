import type { Issue } from "../core/types.js";
import { dedup } from "./dedup.js";
import type { Classification, Classifier, TriageDecision, TriagePlan, Verdict, Verifier } from "./types.js";

const VERDICT_LABEL: Record<Verdict, string> = {
  fixable: "triage:fixable",
  duplicate: "triage:duplicate",
  needs_confirmation: "triage:needs-confirmation",
  unimportant: "triage:unimportant",
  dangerous: "triage:dangerous",
};

function labelsFor(classification: Classification): string[] {
  const labels = [VERDICT_LABEL[classification.verdict]];
  if (classification.surface.trim() !== "") labels.push(classification.surface);
  // Dangerous issues also carry risk + security labels (see /triage-bugs contract).
  if (classification.verdict === "dangerous") labels.push("risk:critical", "security");
  return labels;
}

/**
 * Plan triage for a batch of bug reports: classify each issue, collapse duplicates by fingerprint,
 * and decide labels + promotion. Only safe, non-duplicate, `fixable` issues are promoted into the
 * delivery loop; dangerous/needs-confirmation/unimportant/duplicate are never promoted.
 *
 * Pass issues oldest-first so the canonical of each duplicate group is the oldest report.
 */
export async function planTriage(
  issues: Issue[],
  classifier: Classifier,
  verifier?: Verifier,
): Promise<TriagePlan> {
  const classifications = await Promise.all(issues.map((issue) => classifier.classify(issue)));
  const byId = new Map(classifications.map((c) => [c.issueId, c]));
  const identifierById = new Map(issues.map((issue) => [issue.id, issue.identifier]));

  const { duplicateOf } = dedup(classifications.map((c) => ({ id: c.issueId, fingerprint: c.fingerprint })));

  // Adversarial second opinion: a fixable verdict that fails verification is demoted so it
  // is labeled + left for a human instead of auto-fixed on a shaky call.
  if (verifier) {
    for (const issue of issues) {
      if (duplicateOf.has(issue.id)) continue;
      const c = byId.get(issue.id)!;
      if (c.verdict !== "fixable") continue;
      const { safe, reason } = await verifier.verify(issue, c);
      if (!safe) byId.set(issue.id, { ...c, verdict: "needs_confirmation", reason: `verify: ${reason}` });
    }
  }

  const decisions: TriageDecision[] = issues.map((issue) => {
    const canonicalId = duplicateOf.get(issue.id);
    if (canonicalId !== undefined) {
      return {
        issue,
        verdict: "duplicate",
        labels: [VERDICT_LABEL.duplicate],
        duplicateOf: identifierById.get(canonicalId) ?? canonicalId,
        promote: false,
        reason: `duplicate of ${identifierById.get(canonicalId) ?? canonicalId}`,
      };
    }

    const classification = byId.get(issue.id)!;
    return {
      issue,
      verdict: classification.verdict,
      labels: labelsFor(classification),
      duplicateOf: null,
      promote: classification.verdict === "fixable",
      reason: classification.reason,
    };
  });

  return { decisions };
}
