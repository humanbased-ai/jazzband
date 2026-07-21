// Seed orchestration contract (kept from the initial jazzband skeleton).
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

// --- Core domain model (SPEC §4.1) ---

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/** Normalized issue record used by orchestration, prompt rendering, and observability. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  /** PR number parsed from a Linear attachment URL (`/pull/<n>`), if present. */
  prNumber: number | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

// --- Workflow file (SPEC §4.1.2, §5) ---

/** Raw YAML front-matter root object, before typing/validation. */
export type RawConfig = Record<string, unknown>;

/** Parsed WORKFLOW.md payload. */
export interface WorkflowDefinition {
  config: RawConfig;
  promptTemplate: string;
}

// --- Typed service config (SPEC §4.1.3, §6) ---

export interface TrackerConfig {
  kind: string;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  terminalStates: string[];
}

export interface PollingConfig {
  intervalMs: number;
}

export interface WorkspaceRootConfig {
  root: string;
  /** Git repo (URL or local path, $VAR ok) to check out into each workspace; null = leave empty. */
  repo: string | null;
  /** Branch to work from. */
  base: string;
}

export interface HooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface AgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  /** State keys are normalized to lowercase. */
  maxConcurrentAgentsByState: Record<string, number>;
}

export interface CodexConfig {
  command: string;
  approvalPolicy: string | null;
  threadSandbox: string | null;
  turnSandboxPolicy: string | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

/** Triage classifier config (extension section) — model + how to authenticate to Anthropic. */
export interface ClassifierConfig {
  /** "api" = Anthropic SDK; "claude-cli" = shell out to the logged-in `claude` CLI. */
  runner: "api" | "claude-cli";
  /** CLI command when runner="claude-cli". */
  command: string;
  model: string;
  /** Explicit API key (or $VAR); null falls back to ambient credentials. */
  apiKey: string | null;
  /** Explicit OAuth/bearer token (or $VAR) for subscription auth; null falls back to ambient. */
  authToken: string | null;
}

/** How jazzband opens the PR after the agent finishes (deterministic git wrapper). */
export interface DeliveryConfig {
  /** GitHub "owner/repo" to open the PR against; null disables auto-PR. */
  repo: string | null;
  /** Push URL for the branch (defaults to https://github.com/<repo>.git). */
  remoteUrl: string | null;
  /** Shell command run in the workspace as a quality gate; a non-zero exit blocks the PR. */
  verify: string | null;
  /** Shell command run after the PR opens (with $PR_URL set), e.g. `crosscheck run $PR_URL`. */
  postPr: string | null;
}

/** Typed runtime view derived from WorkflowDefinition.config plus environment resolution. */
export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceRootConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  codex: CodexConfig;
  classifier: ClassifierConfig;
  delivery: DeliveryConfig;
}
