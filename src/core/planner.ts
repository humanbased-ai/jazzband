import type { WorkflowPlan, WorkflowTarget } from "./types.js";

export function createWorkflowPlan(target: WorkflowTarget, dryRun = true): WorkflowPlan {
  const steps = [
    "Load ticket scope from Linear",
    "Resolve or create implementation PR",
    "Wait for Crosscheck APPROVE on the current head SHA",
    "Run VerifyFlow delivery verification",
    "Choose merge, fix, or human-review next action",
  ];

  return {
    target,
    phase: "planned",
    steps,
    dryRun,
  };
}
