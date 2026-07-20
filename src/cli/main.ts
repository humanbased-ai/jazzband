#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, validateDispatchPreflight } from "../core/config.js";
import { JazzbandError } from "../core/errors.js";
import { createWorkflowPlan } from "../core/planner.js";
import { loadWorkflow } from "../core/workflow.js";
import { removeWorkspace, workspacePathFor } from "../core/workspace.js";
import type { Issue, RawConfig, ServiceConfig } from "../core/types.js";
import type { RuntimeSource } from "../runtime/runtime.js";
import { LinearClient } from "../linear/client.js";
import { LinearWriteClient } from "../linear/writes.js";
import { ClaudeAgentClient } from "../agent/claudeClient.js";
import { runLoop } from "../runtime/loop.js";
import { makeAgentDispatcher } from "../runtime/dispatcher.js";
import { Runtime, run as runDelivery } from "../runtime/runtime.js";
import { StatusStore, serveStatus } from "../runtime/status.js";
import { AnthropicClassifier } from "../triage/anthropicClassifier.js";
import { ClaudeCliClassifier } from "../triage/claudeCliClassifier.js";
import { planTriage } from "../triage/engine.js";
import { applyTriage } from "../triage/executor.js";

const USAGE = `Jazzband — TypeScript orchestration for ticket-driven agent workflows

Usage:
  jzb watch  --project <slug> [--interval 30s] [--limit N] [--status-port 7337] [--execute]
  jzb triage (--project <slug> | --workflow <path>) [--limit N] [--execute]
  jzb run    (--project <slug> | --workflow <path>) [--once] [--limit N] [--execute]
  jzb labels (--project <slug> | --workflow <path>)
  jzb check | poll [--project <slug> | --workflow <path>]
  jzb --help

Config comes from --workflow <path> OR --project <slug> (uses $LINEAR_API_KEY +
the claude-cli classifier by default). Flags override the workflow.
Use --states "Backlog,Todo,In Progress" to set which issue states to watch.

Commands:
  watch    Continuously monitor a project: triage → work fixable, every --interval. The one-liner.
  triage   Classify + dedup + label bug reports; --execute writes labels/comments (else dry-run).
  run      Work triage:fixable issues with a Claude coding agent; --execute launches agents.
  labels   Ensure the triage:* labels exist on the team.
  check    Resolve config + run dispatch preflight. poll: show one tick's dispatch decision.
`;

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }

  return { command, flags };
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function parseInterval(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  const unit = match[2] ?? "s";
  return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60000 : n * 3600000;
}

const DEFAULT_PROMPT =
  "Fix {{ issue.identifier }}: {{ issue.title }}.\n\n{{ issue.description }}\n\n" +
  "Fix EXACTLY the control/behavior the user reported — match their wording (e.g. a 'watch' button is the Watch/Follow control, not a nearby Enroll/Join button); locate the right component and confirm it matches before editing. Write a test first, keep the change surgical. Do NOT touch git — jazzband opens the PR after you finish.";

/** Build config from either --workflow <path> or --project <slug>, applying flag overrides. */
function loadCliConfig(flags: Record<string, string | boolean>): { config: ServiceConfig; promptTemplate: string } {
  const project = stringFlag(flags, "project");
  const workflowFlag = stringFlag(flags, "workflow");

  let raw: RawConfig;
  let promptTemplate: string;
  let workflowDir: string;
  if (workflowFlag) {
    const loaded = loadWorkflow(resolve(workflowFlag));
    raw = loaded.config;
    promptTemplate = loaded.promptTemplate;
    workflowDir = dirname(resolve(workflowFlag));
  } else if (project) {
    raw = { tracker: { kind: "linear", api_key: "$LINEAR_API_KEY", project_slug: project }, classifier: { runner: "claude-cli" } };
    promptTemplate = DEFAULT_PROMPT;
    workflowDir = process.cwd();
  } else {
    throw new JazzbandError("config_validation_error", "provide --workflow <path> or --project <slug>");
  }

  const config = resolveConfig(raw, { workflowDir });
  if (project) config.tracker.projectSlug = project;
  const interval = stringFlag(flags, "interval");
  if (interval) config.polling.intervalMs = parseInterval(interval, config.polling.intervalMs);
  const states = stringFlag(flags, "states");
  if (states) config.tracker.activeStates = states.split(",").map((s) => s.trim()).filter(Boolean);
  return { config, promptTemplate };
}

/** Wrap a LinearClient as a RuntimeSource, optionally capping candidates per --limit. */
function toSource(client: LinearClient, flags: Record<string, string | boolean>): RuntimeSource {
  const raw = Number(stringFlag(flags, "limit"));
  const limit = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  const only = stringFlag(flags, "issue")?.toLowerCase();
  return {
    fetchCandidateIssues: async () => {
      let issues = await client.fetchCandidateIssues();
      if (only) issues = issues.filter((i) => i.identifier.toLowerCase() === only);
      return limit ? issues.slice(0, limit) : issues;
    },
    fetchIssueStatesByIds: (ids) => client.fetchIssueStatesByIds(ids),
  };
}

const TRIAGE_LABELS = [
  "triage:fixable",
  "triage:duplicate",
  "triage:needs-confirmation",
  "triage:unimportant",
  "triage:dangerous",
];

/** Remove workspaces for issues already in terminal states (SPEC §8.6). Best-effort. */
async function startupCleanup(config: ServiceConfig, client: LinearClient): Promise<number> {
  let removed = 0;
  try {
    const terminal = await client.fetchIssuesByStates(config.tracker.terminalStates);
    for (const issue of terminal) {
      const path = workspacePathFor(config.workspace.root, issue.identifier);
      await removeWorkspace({ root: config.workspace.root, path, hookTimeoutMs: config.hooks.timeoutMs });
      removed += 1;
    }
  } catch {
    // best-effort per SPEC §8.6 — a failed cleanup must not block startup
  }
  return removed;
}

function makeClassifier(config: ServiceConfig) {
  return config.classifier.runner === "claude-cli"
    ? new ClaudeCliClassifier({ command: config.classifier.command, model: config.classifier.model })
    : new AnthropicClassifier({
        model: config.classifier.model,
        apiKey: config.classifier.apiKey,
        authToken: config.classifier.authToken,
      });
}

/** Sink for user-facing progress lines; the status server swaps this to also record events. */
let report: (text: string) => void = (text) => console.log(text);

/** Classify + (optionally) label the project's candidates. */
async function doTriage(config: ServiceConfig, source: RuntimeSource, execute: boolean): Promise<void> {
  const issues = await source.fetchCandidateIssues();
  const plan = await planTriage(issues, makeClassifier(config));
  for (const d of plan.decisions) {
    const dup = d.duplicateOf ? ` → dup of ${d.duplicateOf}` : "";
    report(`triage ${d.issue.identifier} ${d.verdict}${dup} :: ${d.labels.join(", ")}`);
  }
  if (execute) {
    const result = await applyTriage(plan, new LinearWriteClient(config.tracker));
    report(`triage applied: labeled ${result.labeled}`);
  } else {
    report(`triage dry-run — ${plan.decisions.length} classified. Add --execute to write labels.`);
  }
}

/** Work the triage:fixable candidates with a Claude coding agent (execute) or list them (dry). */
async function doRun(
  config: ServiceConfig,
  promptTemplate: string,
  source: RuntimeSource,
  execute: boolean,
  once: boolean,
): Promise<void> {
  if (!execute) {
    const runtime = new Runtime({ config, source, worker: async () => ({ ok: true }), now: () => Date.now() });
    const dispatch = runtime.planDispatch(await source.fetchCandidateIssues());
    for (const issue of dispatch) report(`run would work ${issue.identifier} (${issue.state})`);
    report(`run dry-run — ${dispatch.length} triage:fixable issue(s). Add --execute to launch Claude agents.`);
    return;
  }
  const worker = async (issue: Issue) => {
    let ok = false;
    await makeAgentDispatcher({
      config,
      promptTemplate,
      makeClient: () => new ClaudeAgentClient({ turnTimeoutMs: config.codex.turnTimeoutMs }),
      onOutcome: (i, outcome) => {
        ok = outcome.ok;
        report(`run ${i.identifier}: agent ${outcome.ok ? "succeeded" : "failed"} (${outcome.turns} turn(s))`);
      },
      onPr: async (i, result) => {
        if (!result.opened) {
          report(`run ${i.identifier}: no PR (${result.reason})`);
          return;
        }
        report(`run ${i.identifier}: PR opened → ${result.prUrl}`);
        // Close the loop: link the PR on the Linear issue and (optionally) move its state.
        try {
          const writer = new LinearWriteClient(config.tracker);
          await writer.createComment(i.id, `🔧 Jazzband opened a PR for this bug: ${result.prUrl}\n\nReview and merge when ready — Jazzband never merges.`);
          if (config.delivery.reviewState) {
            const stateId = await writer.resolveStateId(config.delivery.reviewState);
            await writer.updateIssue(i.id, { stateId });
          }
        } catch (error) {
          console.error(`run ${i.identifier}: PR opened but Linear write-back failed: ${(error as Error).message}`);
        }
      },
    })(issue);
    return { ok };
  };
  await runDelivery({ config, source, worker, now: () => Date.now(), log: (m) => console.error(m) }, { once });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (command === "check") {
    const workflowPath = resolve(stringFlag(flags, "workflow") ?? "WORKFLOW.md");
    try {
      const workflow = loadWorkflow(workflowPath);
      const config = resolveConfig(workflow.config, { workflowDir: dirname(workflowPath) });
      validateDispatchPreflight(config);
      console.log(
        JSON.stringify(
          {
            ok: true,
            workflow: workflowPath,
            tracker: {
              kind: config.tracker.kind,
              projectSlug: config.tracker.projectSlug,
              endpoint: config.tracker.endpoint,
            },
            pollIntervalMs: config.polling.intervalMs,
            workspaceRoot: config.workspace.root,
            maxConcurrentAgents: config.agent.maxConcurrentAgents,
          },
          null,
          2,
        ),
      );
      return 0;
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "poll") {
    const workflowPath = resolve(stringFlag(flags, "workflow") ?? "WORKFLOW.md");
    try {
      const workflow = loadWorkflow(workflowPath);
      const config = resolveConfig(workflow.config, { workflowDir: dirname(workflowPath) });
      const client = new LinearClient(config.tracker);
      await runLoop(
        {
          config,
          source: client,
          dispatch: (issue) => console.log(`dispatch ${issue.identifier} (${issue.state})`),
          log: (message) => console.error(message),
        },
        { once: Boolean(flags.once) },
      );
      return 0;
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "triage") {
    try {
      const { config } = loadCliConfig(flags);
      const source = toSource(new LinearClient(config.tracker), flags);
      await doTriage(config, source, Boolean(flags.execute));
      return 0;
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "run") {
    try {
      const { config, promptTemplate } = loadCliConfig(flags);
      const client = new LinearClient(config.tracker);
      if (flags.execute) await startupCleanup(config, client);
      await doRun(config, promptTemplate, toSource(client, flags), Boolean(flags.execute), Boolean(flags.once));
      return 0;
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "watch") {
    try {
      const { config, promptTemplate } = loadCliConfig(flags);
      const client = new LinearClient(config.tracker);
      const source = toSource(client, flags);
      const execute = Boolean(flags.execute);
      if (execute) await startupCleanup(config, client);

      const statusPort = Number(stringFlag(flags, "status-port"));
      if (Number.isInteger(statusPort) && statusPort > 0) {
        const store = new StatusStore({
          startedAt: new Date().toISOString(),
          project: config.tracker.projectSlug ?? "?",
          mode: execute ? "execute" : "dry-run",
        });
        serveStatus(store, statusPort);
        report = (text) => {
          console.log(text);
          store.event(new Date().toISOString(), text);
        };
        console.error(`status: http://127.0.0.1:${statusPort}`);
        for (;;) {
          store.tick(new Date().toISOString());
          await doTriage(config, source, execute);
          await doRun(config, promptTemplate, source, execute, true);
          if (flags.once) return 0;
          await sleep(config.polling.intervalMs);
        }
      }

      console.error(`watch: ${config.tracker.projectSlug} every ${config.polling.intervalMs}ms${execute ? " (EXECUTE)" : " (dry-run)"}`);
      for (;;) {
        await doTriage(config, source, execute); // classify + label
        await doRun(config, promptTemplate, source, execute, true); // work the fixable ones
        if (flags.once) return 0;
        await sleep(config.polling.intervalMs);
      }
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "labels") {
    try {
      const { config } = loadCliConfig(flags);
      const writer = new LinearWriteClient(config.tracker);
      for (const name of TRIAGE_LABELS) {
        const id = await writer.ensureLabelId(name);
        console.log(`${name} → ${id}`);
      }
      return 0;
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "plan") {
    const plan = createWorkflowPlan(
      {
        ticket: stringFlag(flags, "ticket"),
        repo: stringFlag(flags, "repo"),
      },
      !flags.execute,
    );
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  if (command === "status") {
    console.log(
      JSON.stringify(
        {
          pr: stringFlag(flags, "pr"),
          state: "not_connected",
          next: "Wire GitHub PR reads, Crosscheck markers, and VerifyFlow markers.",
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.error(`Unknown command: ${command}\n`);
  console.log(USAGE);
  return 2;
}

function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // Resolve symlinks so an installed bin (e.g. /opt/homebrew/bin/jzb → dist/cli/main.js) matches.
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    },
  );
}
