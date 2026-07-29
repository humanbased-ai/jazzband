# Design: Autonomous Triage + Sandboxed Execution

Status: **proposal — review before implementation.** This document specifies two new Jazzband
capabilities and the contracts they introduce. No implementation lands until this is approved.

## 1. Where this fits

Jazzband's job is to drive the public delivery loop:

```
Linear ticket  →  implementation PR  →  Crosscheck review  →  VerifyFlow verification  →  human merge
```

Most of that loop already runs today via **Symphony** (Python daemon) + **Crosscheck** (review CLI).
Two pieces are missing, and they are the scope of this design:

1. **Triage** — decide *which* Backlog issues become agent work, and *when*. Today a human promotes
   `Backlog → Todo` by hand. We want classification, an auto-promote policy, and a stale-claim takeover.
2. **Sandboxed execution** — run the coding agent in an **ephemeral Docker container**, not on the host.
   Symphony runs `claude --permission-mode bypassPermissions` directly on the machine; that is unsafe
   for unattended autonomous runs.

The loop, with the new pieces marked `*`:

```
┌──────────────────────── Jazzband daemon (Mac mini → cloud, one artifact) ─────────────────────────┐
 Linear Backlog ─▶ * TRIAGE   classify code_fixable | operational | needs_human;
 (intake issues)              promote eligible → Todo + assign + comment plan; 5h stale-claim takeover
                                │
 Linear Todo ────▶   DISPATCH ─▶ * DOCKER SANDBOX: claude/codex implements → PR → comments the ticket
                                │   (host FS unmounted · scoped creds · egress + cpu + time limits)
 GitHub PR ──────▶   OBSERVE  ─▶ crosscheck scan --json → APPROVE? ─no─▶ resume agent (address review)
                                │                                  └─yes─▶ VerifyFlow → ready_to_merge
                                ▼
                       human merges   ◀── hard gate; Jazzband never auto-merges
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Design principles (inherited)

From the README + `architecture.md`, and binding on this design:

- **Dry-run first.** Every command computes and prints its plan; side effects require an explicit
  `--execute` flag. Triage's default is dry-run.
- **Public handoffs.** Read/write Linear metadata, GitHub PR links/labels/comments/statuses, and
  Crosscheck/VerifyFlow SHA-bound markers. Never scrape another tool's private logs.
- **Separate config / state / logs.** `~/.jazzband/config.json`, `.jazzband/runs/`, `.jazzband/logs/`.
- **Ports over implementations.** New behavior is defined as a TypeScript port (interface); concrete
  adapters (Linear, GitHub, Crosscheck, Docker) implement it and are injected. Keeps the core testable
  with `node:test` + fakes.

## 3. Component A — Triage

### 3.1 Inputs

Backlog issues from Linear. Intake issues from the forms tool are recognizable by the fixed title
pattern `[Side · Category] Org — summary`, so triage can scope to them without a dedicated label
(a label remains an option).

### 3.2 Classification

A cheap LLM call (Claude Haiku via the subscription, or OpenRouter) reads the issue and returns one of:

- **`code_fixable`** — a defect that maps to a code change, with a repro / error / log. Eligible for an agent.
- **`operational`** — not a code bug: balance/billing/account/access/quota. *Example: the recurring
  `402 insufficient_balance` Codatta failure is operational — an agent must never open a "fix" PR for it.*
- **`needs_human`** — ambiguous, security-sensitive, or design-level. Route to a person.

Classification maps onto the intake taxonomy: `demand/data_access`, `demand/campaign`, `pipeline`,
`api_error` lean `code_fixable`; `billing`, `account`, `access`, `rewards` lean `operational`.

### 3.3 Policy

Promotion is gated, conservatively, by a policy object (see contracts). Auto-promote only when
`class ∈ eligibleClasses`, `confidence ≥ minConfidence`, `category ∈ allowedCategories`, and
`category ∉ blockedCategories`. Everything else gets a "needs human triage" comment and stays put.
A **dry-run shadow period** (log decisions, take no action) precedes enabling `--execute`.

### 3.4 Stale-claim takeover

Separately, scan active issues (Todo / In Progress) assigned to a human where
`now − updatedAt > staleClaimHours (=5)` **AND** there is no linked PR **AND** no active agent run
(where "active" is tracked in the `.jazzband/runs/` state store — see `TrackerPort.activeRunId`).
`updatedAt` is the issue's last state-change or assignment timestamp, not the creation time — a human
claim made seconds ago has a fresh `updatedAt` and is never displaced before the window expires.
On match: comment, reassign to the agent identity, ensure `Todo`. The "no linked PR + no active run"
guard guarantees we never steal a fix that is already in flight.

### 3.5 Actions & side effects

`promote` → move `Backlog → Todo`, assign agent, comment the proposed approach + a reclaim note
("🤖 Jazzband is picking this up; reassign to yourself to reclaim"). `takeover`, `needs_human`, and
`skip` behave as named. In dry-run, actions are computed and printed but not sent.

Once an issue is in `Todo`, the **existing Symphony loop already picks it up** — so triage delivers
value before any of Jazzband's own execution code exists.

## 4. Component B — Docker sandbox runner

### 4.1 Why Docker

The chosen isolation is a container per run. One image runs identically on the Mac mini
(Docker Desktop or colima) and any cloud VM — satisfying "start local, optionally cloud" with a single
artifact. Inside the container `--permission-mode bypassPermissions` is acceptable because it bypasses
permissions in a **throwaway container**, not on the host.

### 4.2 Container shape

- **Image** `jazzband-agent:<tag>`: Node + the agent CLIs (`claude`, `codex`) + `git` + `gh`.
- **No host bind mount** of the workspace — the entrypoint clones the repo fresh *inside* the container.
- **Auth**: the agent's subscription credentials **never enter the container filesystem**. A read-only
  mount is explicitly rejected — read-only blocks writes, not reads, and `api.anthropic.com` is on the
  egress allowlist, so a malicious repo could read a mounted credential and abuse it through the
  approved channel. Instead the egress proxy (below) terminates the provider connection and **injects
  the auth header** server-side; where a CLI cannot be pointed at a proxy, fall back to **short-lived,
  per-run credentials** minted before the run and revoked at teardown. This is the trust boundary — see Risks.
- **Scoped env**: a fine-grained, repo-scoped `GITHUB_TOKEN` and `LINEAR_API_KEY`, nothing else.
- **Egress allowlist**: only `api.github.com`, `github.com`, `api.linear.app`, `api.anthropic.com`
  (+ Codex/OpenRouter hosts as needed). Docker has no native per-host egress allowlist, so the
  recommended approach is a sidecar forward-proxy (tinyproxy/squid allowlist) on a private bridge with
  the agent container on `--network` pointed at it; `--network none` + proxy is the strict variant. The
  same proxy injects the provider auth header (see Auth), so credentials never reside inside the container.
- **Resource caps**: `--cpus`, `--memory`, `--pids-limit`, a wall-clock `timeoutMs`, and an agent
  budget cap (`claude --max-budget-usd`, mirroring Crosscheck).
- **Ephemeral**: `--rm`; the container and its clone are destroyed after the run. Logs stream to
  `.jazzband/logs/<runId>.log` on the host.

### 4.3 Invocation sketch

```
docker run --rm \
  --network jazzband-egress           # private bridge → allowlist proxy (injects provider auth) \
  --cpus 2 --memory 4g --pids-limit 512 \
  -e GITHUB_TOKEN -e LINEAR_API_KEY   # no subscription-auth mount — the proxy injects it \
  jazzband-agent:<tag> \
  jzb-agent-entry --ticket IN-123 --repo humanbased-ai/monorepo --agent claude_code --max-turns 60
```

The entrypoint mirrors today's Symphony WORKFLOW.md prompt (clone → branch/checkout existing PR →
TDD → quality gate → push → `gh pr create` → comment ticket → move *In Review*). That prompt is
reused, not reinvented. On exit it writes a structured result artifact (`runId`, `prUrl`, `sessionId`,
`exitCode`) that the host reads directly, rather than parsing free-form stdout for the PR URL.

## 5. Proposed contracts

New `src/core/types.ts` additions and `src/adapters/*` ports. Marked proposed; not yet implemented.

```ts
// ---- Triage ----
export interface TriageCandidate {
  id: string; identifier: string; title: string; description: string;
  state: string; assigneeId: string | null; createdAt: string; updatedAt: string; url: string; labels: string[];
}
export type TriageClass = "code_fixable" | "operational" | "needs_human";
export interface TriageAssessment {
  class: TriageClass; category: string; confidence: number; // 0..1 — validated/clamped at the ClassifierPort boundary
  proposedApproach: string; rationale: string;
}
export interface TriagePolicy {
  eligibleClasses: TriageClass[]; minConfidence: number;
  allowedCategories: string[]; blockedCategories: string[]; staleClaimHours: number;
}
export type TriageAction =
  | { kind: "promote"; toState: string; assigneeId: string; comment: string }
  | { kind: "takeover"; reason: string; assigneeId: string; comment: string }
  | { kind: "needs_human"; comment: string }
  | { kind: "skip"; reason: string };
export interface TriageDecision {
  candidate: TriageCandidate; assessment: TriageAssessment; action: TriageAction; dryRun: boolean;
}

// ---- Sandboxed execution ----
export interface AgentRunRequest {
  ticket: TriageCandidate; repo: string; agent: "claude_code" | "codex";
  model?: string; maxTurns: number; timeoutMs: number; budgetUsd?: number;
  env: Record<string, string>;
}
// `prUrl`/`sessionId` are read from a structured result artifact the entrypoint writes on exit
// (a known JSON line / result file), never by scraping free-form container stdout.
export interface AgentRunResult {
  runId: string; exitCode: number; durationMs: number;
  prUrl: string | null; sessionId: string | null; logPath: string;
}

// ---- Review / verification ----
export type Verdict = "APPROVE" | "NEEDS_WORK" | "BLOCK" | "PENDING";
export interface ReviewState { prUrl: string; headSha: string; verdict: Verdict; commitCount: number; }
export interface VerificationResult { prUrl: string; headSha: string; passed: boolean; evidenceUrl?: string; }

// ---- Run state ----
// `WorkflowTarget`, `WorkflowPhase`, and `WorkflowPlan` are existing types already defined in
// `src/core/types.ts` (`WorkflowPlan` carries `target`, `phase`, `steps`, `dryRun`). `WorkflowRun`
// is the one new type here; it extends `WorkflowPlan` and adds the live execution state below.
export interface WorkflowRun extends WorkflowPlan {
  runId: string;
  agentRun?: AgentRunResult; review?: ReviewState; verification?: VerificationResult;
  startedAt: string; updatedAt: string;
}
```

```ts
// ---- Ports (src/adapters/) ----
export interface TrackerPort {
  listBacklog(filter: { titlePattern?: RegExp; label?: string }): Promise<TriageCandidate[]>;
  listActive(): Promise<TriageCandidate[]>;
  linkedPrUrl(issueId: string): Promise<string | null>;
  /**
   * Returns the runId of any agent run currently working this issue, or null if none.
   * "Active run" is NOT a Linear/GitHub native concept: it is tracked in the `.jazzband/runs/`
   * run-state store (see Design principles). An issue is active when a persisted `WorkflowRun`
   * references its `issueId` in a non-terminal `phase` (anything before `ready_to_merge`); that
   * store is the single source of truth the stale-claim guard consults.
   */
  activeRunId(issueId: string): Promise<string | null>;
  promote(issueId: string, toState: string, assigneeId: string): Promise<void>;
  assign(issueId: string, assigneeId: string): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;
}
// The adapter MUST validate/clamp `assessment.confidence` into [0,1] at this boundary before it
// reaches the policy gate (e.g. reject or rescale an LLM that returns 95 instead of 0.95); otherwise
// the `confidence ≥ minConfidence` comparison silently passes on out-of-range values.
export interface ClassifierPort { assess(c: TriageCandidate): Promise<TriageAssessment>; }
export interface AgentRunner { run(req: AgentRunRequest): Promise<AgentRunResult>; }
export interface ReviewerPort {              // Crosscheck adapter
  scan(): Promise<ReviewState[]>;            // `crosscheck scan --json`
  reviewState(prUrl: string): Promise<ReviewState>;
  // maps to `crosscheck run <prUrl>` with the reviewer selected via its reviewer flag
  // (e.g. `--reviewer <claude|codex>`); the `reviewer` param is passed straight through to that flag.
  trigger(prUrl: string, reviewer: "claude" | "codex"): Promise<void>;
}
export interface VerifierPort { verify(prUrl: string): Promise<VerificationResult>; }
```

Two `AgentRunner` implementations: `DockerSandboxRunner` (default) and `LocalProcessRunner`
(dev only, no isolation). `LocalProcessRunner` is guarded against accidental production use: the runner
factory selects it only when config validation confirms `runner: "local"` **and** an explicit `isDev`
flag is set; any other configuration falls back to `DockerSandboxRunner`.

## 6. Deployment

- **Mac mini (start here):** Jazzband daemon as a `launchd` service; **colima** for headless Docker
  (no GUI). The daemon is lightweight (poll + orchestrate); each agent run is a separate container.
  Subscription auth lives on the host (`~/.claude` / Codex config); the egress proxy injects it per run
  and it is never mounted into the container.
- **Cloud (same artifacts):** the daemon on a small always-on VM with Docker, OR per-run containers as
  jobs (k8s Job / Fly Machine / Vercel Sandbox for the cloud-native ephemeral variant). The unit of work
  is "run image `jazzband-agent:<tag>`," so local and cloud differ only in *where* the container starts.
- **Secrets:** repo-scoped fine-grained `GITHUB_TOKEN`, `LINEAR_API_KEY`, agent subscription auth.
  Held in the host secret store, injected per run, never baked into the image.

## 7. Migration from Symphony (incremental, de-risked)

- **Phase A:** ship `jazzband triage` in front of the *running* Symphony loop. Symphony unchanged;
  it keeps polling `Todo`. Triage promotes into `Todo`. → value immediately, zero execution risk.
- **Phase B:** `jazzband dispatch` with `DockerSandboxRunner` executes new triaged tickets in a
  sandbox; run both in parallel during cutover (Jazzband owns intake-triaged tickets, Symphony owns
  existing project epics) to de-risk.
- **Phase C:** `jazzband observe` (crosscheck `scan` + VerifyFlow + run state) closes the loop;
  retire the Python Symphony daemon.

## 8. Risks & open questions

- **Subscription terms (go/no-go gate — resolve before implementation).** Confirm Claude Code + Codex
  subscription terms permit headless / containerized / cloud use. This is a go/no-go gate on the whole
  sandboxed-execution component and must be resolved before implementation begins, not during it: the
  fallback (API keys for the agent runner) is design-compatible but carries real per-run cost.
- **Secret-in-sandbox.** Provider auth is the trust boundary; a malicious repo + a compromised agent
  could attempt exfiltration. A read-only mount does **not** close this — read-only blocks writes, not
  reads, and `api.anthropic.com` is allowlisted, so a mounted credential is exfiltratable through the
  approved channel. Mitigations: inject the auth header at the egress proxy (credential never enters the
  container) or mint short-lived per-run credentials, repo-scoped tokens, egress allowlist, no other
  host secrets, ephemeral container, per-run teardown.
- **Egress allowlisting** in Docker needs a proxy sidecar — non-trivial; spec'd above, to be prototyped.
- **Classification false-positives.** A mis-classified operational issue could draw an agent PR.
  Mitigations: conservative allowlist policy, min-confidence gate, the dry-run shadow period, and the
  always-on human merge gate.
- **Runaway cost.** `max_concurrent_agents`, `max_turns`, per-run `timeoutMs`, and `budgetUsd` caps.
- **Idempotency.** Triage and dispatch must be safe to re-run on the same tick (no double promote, no
  duplicate PR) — keyed on issue id + linked-PR presence.
