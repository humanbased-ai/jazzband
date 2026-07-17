import type { Issue } from "../core/types.js";
import type { TriageDecision, TriagePlan } from "./types.js";

/** The write surface the executor needs (LinearWriteClient satisfies this structurally). */
export interface TriageWriter {
  addLabel(issueId: string, name: string): Promise<void>;
  createComment(issueId: string, body: string): Promise<void>;
  resolveStateId(name: string): Promise<string>;
  updateIssue(issueId: string, input: { title?: string; stateId?: string; projectId?: string }): Promise<void>;
}

/** Where promoted (fixable) issues are handed to the delivery loop. */
export interface PromoteTarget {
  projectId: string;
  stateName: string;
}

export interface ApplyTriageOptions {
  promote?: PromoteTarget;
}

function routingComment(decision: TriageDecision): string {
  if (decision.verdict === "duplicate") {
    return `🔁 Usher — duplicate of ${decision.duplicateOf}. Collapsed; not entering the delivery loop.`;
  }
  if (decision.promote) {
    return `🟢 Usher — picked up. Classified fixable (low-risk). ${decision.reason}`;
  }
  return `🟡 Usher — ${decision.verdict}. ${decision.reason}`;
}

/** Intake-shaped title so a promoted report satisfies the delivery guard (retitle only). */
function intakeTitle(issue: Issue): string {
  return `[supply · bug] Online — ${issue.title}`;
}

/**
 * Apply a triage plan to the tracker: label every issue, add its routing comment, and promote the
 * safe fixable ones (retitle to intake shape + move to the target state + assign the delivery
 * project). Callers gate on dry-run by simply not calling this.
 */
export async function applyTriage(
  plan: TriagePlan,
  writer: TriageWriter,
  options: ApplyTriageOptions = {},
): Promise<{ labeled: number; promoted: number }> {
  let promoted = 0;

  for (const decision of plan.decisions) {
    for (const label of decision.labels) {
      await writer.addLabel(decision.issue.id, label);
    }
    await writer.createComment(decision.issue.id, routingComment(decision));

    if (decision.promote && options.promote) {
      const stateId = await writer.resolveStateId(options.promote.stateName);
      await writer.updateIssue(decision.issue.id, {
        title: intakeTitle(decision.issue),
        stateId,
        projectId: options.promote.projectId,
      });
      promoted += 1;
    }
  }

  return { labeled: plan.decisions.length, promoted };
}
