export interface WorkflowTarget {
  ticket?: string;
  repo?: string;
  pr?: string;
}

export type WorkflowPhase =
  | "planned"
  | "implementation_pending"
  | "review_pending"
  | "verification_pending"
  | "ready_to_merge";

export interface WorkflowPlan {
  target: WorkflowTarget;
  phase: WorkflowPhase;
  steps: string[];
  dryRun: boolean;
}
