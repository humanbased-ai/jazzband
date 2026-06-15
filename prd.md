# Jazzband PRD

Jazzband is the TypeScript orchestration layer for ticket-driven agent workflows — the npm-native
successor to the Python Symphony daemon. It drives the loop
`Linear ticket → implementation PR → Crosscheck review → VerifyFlow verification → human merge`,
dispatching coding agents (Claude Code / Codex) and composing with Crosscheck and VerifyFlow.

Design detail for the items below: [`docs/triage-and-sandbox.md`](docs/triage-and-sandbox.md).
Architecture overview: [`docs/architecture.md`](docs/architecture.md).

## Principles

- Dry-run first; irreversible actions require an explicit `--execute` flag.
- Public handoffs only (Linear / GitHub / Crosscheck / VerifyFlow metadata + SHA-bound markers); no
  private-log scraping.
- Separate config (`~/.jazzband/config.json`), runs (`.jazzband/runs/`), logs (`.jazzband/logs/`).
- Ports over implementations; core stays testable with `node:test` + fakes.
- Never auto-merge. The human merge gate is non-negotiable.

## Build Queue

### 🔜 Next Up

- [ ] **Autonomous triage (`jazzband triage`)** — Promote eligible Backlog issues into the existing loop.
  - **User:** the team running the delivery loop; secondarily the clients whose intake issues get acted on.
  - **Acceptance Criteria:**
    - `jazzband triage --repo <r>` lists Backlog candidates (intake issues via the `[Side · Category]`
      title pattern, or `--label`) and prints a `TriageDecision[]` as JSON. **Dry-run by default.**
    - Each candidate is classified `code_fixable | operational | needs_human` via a `ClassifierPort`
      (Claude Haiku / OpenRouter). Operational issues (e.g. `402 insufficient_balance`) are never promoted.
    - A `TriagePolicy` gates promotion: `class ∈ eligibleClasses`, `confidence ≥ minConfidence`,
      `category ∈ allowedCategories`, `category ∉ blockedCategories`.
    - `--execute` performs side effects: `Backlog → Todo`, assign the agent identity, comment the
      proposed approach + reclaim note. Non-eligible → "needs human triage" comment, left in Backlog.
    - **5h stale-claim takeover:** active issues assigned to a human with `now − createdAt > 5h` AND no
      linked PR AND no active run are commented, reassigned to the agent, and ensured `Todo`.
    - Idempotent across ticks (no double-promote; keyed on issue id + linked-PR presence).
  - **Technical Notes:** new `src/core/triager.ts`, `src/adapters/{TrackerPort,ClassifierPort}.ts`,
    CLI case in `src/cli/main.ts`. Runs in front of the *running* Symphony loop — no execution code yet.
  - **Tests Required:** classification routing per class; policy gate accept/reject (eligible category,
    low confidence, blocked category); operational issue never promoted; stale-takeover fires only with
    no-PR + stale; dry-run emits decisions but no side effects (fake `TrackerPort` records zero writes);
    idempotent re-run.

### 🧊 Backlog

- [ ] **Docker sandbox runner (`DockerSandboxRunner`)** — Run the coding agent in an ephemeral container.
  - **User:** operators running unattended autonomous runs on a Mac mini or cloud VM.
  - **Acceptance Criteria:**
    - `AgentRunner` port with `DockerSandboxRunner` (default) + `LocalProcessRunner` (dev, explicit).
    - One container per run: agent CLI + git + gh; repo cloned **inside**; host FS not bind-mounted.
    - Subscription auth mounted read-only; only repo-scoped `GITHUB_TOKEN` + `LINEAR_API_KEY` in env.
    - Egress restricted to the allowlist (GitHub / Linear / Anthropic / Codex) via a proxy sidecar.
    - Resource caps (`--cpus`, `--memory`, `--pids-limit`), wall-clock `timeoutMs`, `budgetUsd` cap.
    - `--rm`; logs stream to `.jazzband/logs/<runId>.log`; returns `AgentRunResult` (incl. parsed PR URL).
  - **Technical Notes:** `src/adapters/DockerSandboxRunner.ts`, an agent `Dockerfile` + entrypoint
    reusing the Symphony WORKFLOW.md prompt; `colima` for headless local Docker.
  - **Tests Required:** request → docker args mapping (image, caps, mounts, env, network); auth mount is
    read-only; no host workspace mount; missing-auth and timeout error paths; PR-URL parse from output.

- [ ] **Jazzband dispatch + observe; retire Symphony** — Move the full loop into Jazzband.
  - **User:** the team; outcome is a single TS orchestrator.
  - **Acceptance Criteria:**
    - `jazzband run --ticket … --execute` dispatches via `DockerSandboxRunner`, then observes the PR:
      `ReviewerPort.scan()` (`crosscheck scan --json`) → on `NEEDS_WORK/BLOCK` resume the agent to
      address review; on `APPROVE` call `VerifierPort.verify()` → `ready_to_merge`. Never merges.
    - `WorkflowRun` state persisted under `.jazzband/runs/`; resumable.
    - Parallel-run parity with Symphony validated on a real ticket; then Symphony decommissioned.
  - **Technical Notes:** `src/adapters/{ReviewerPort,VerifierPort}.ts`, `src/core/orchestrator.ts`,
    `src/core/storage.ts`. VerifyFlow integration contract TBD.
  - **Tests Required:** verdict-driven branching (approve→verify, needs-work→resume); run-state
    persistence/resume; idempotent dispatch (no duplicate PR); merge is never invoked.

## Out of Scope (for now)

- Auto-merge. Human confirmation at merge stays mandatory.
- A Supabase/DB mirror of ticket state — Linear + GitHub remain the source of truth (public handoffs).
