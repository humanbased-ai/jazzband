#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, validateDispatchPreflight } from "../core/config.js";
import { JazzbandError } from "../core/errors.js";
import { createWorkflowPlan } from "../core/planner.js";
import { loadWorkflow } from "../core/workflow.js";
import type { Issue } from "../core/types.js";
import { LinearClient } from "../linear/client.js";
import { LinearWriteClient } from "../linear/writes.js";
import { ClaudeAgentClient } from "../agent/claudeClient.js";
import { runLoop } from "../runtime/loop.js";
import { makeAgentDispatcher } from "../runtime/dispatcher.js";
import { Runtime, run as runDelivery } from "../runtime/runtime.js";
import { AnthropicClassifier } from "../triage/anthropicClassifier.js";
import { ClaudeCliClassifier } from "../triage/claudeCliClassifier.js";
import { planTriage } from "../triage/engine.js";
import { applyTriage } from "../triage/executor.js";

const USAGE = `Jazzband — TypeScript orchestration for ticket-driven agent workflows

Usage:
  jazzband check [--workflow <path>]
  jazzband poll [--workflow <path>] [--once]
  jazzband triage [--workflow <path>] [--execute]
  jazzband run [--workflow <path>] [--once] [--execute]
  jazzband plan --ticket <KEY> --repo <owner/repo>
  jazzband status --pr <url|owner/repo#N>
  jazzband --help

Commands:
  check    Load a WORKFLOW.md, resolve config, and run dispatch preflight. No side effects.
  poll     Poll the tracker and print the dispatch decision. --once runs one tick and exits.
  triage   Poll, classify + dedup + label bug reports; --execute writes to Linear (else dry-run).
  run      Poll + work triage:fixable issues with a Claude coding agent; --execute launches agents.
  plan     Print the intended workflow plan. No side effects.
  run      Start from the same plan shape. Side effects require --execute.
  status   Inspect the public PR orchestration state. Placeholder in this seed.
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
    const workflowPath = resolve(stringFlag(flags, "workflow") ?? "WORKFLOW.md");
    try {
      const workflow = loadWorkflow(workflowPath);
      const config = resolveConfig(workflow.config, { workflowDir: dirname(workflowPath) });
      const issues = await new LinearClient(config.tracker).fetchCandidateIssues();
      const classifier =
        config.classifier.runner === "claude-cli"
          ? new ClaudeCliClassifier({ command: config.classifier.command, model: config.classifier.model })
          : new AnthropicClassifier({
              model: config.classifier.model,
              apiKey: config.classifier.apiKey,
              authToken: config.classifier.authToken,
            });
      const plan = await planTriage(issues, classifier);

      for (const decision of plan.decisions) {
        const dup = decision.duplicateOf ? ` → dup of ${decision.duplicateOf}` : "";
        const promote = decision.promote ? " [PROMOTE]" : "";
        console.log(`${decision.issue.identifier} ${decision.verdict}${dup}${promote} :: ${decision.labels.join(", ")}`);
      }

      if (flags.execute) {
        const writer = new LinearWriteClient(config.tracker);
        const result = await applyTriage(plan, writer);
        console.log(`applied: labeled ${result.labeled}, promoted ${result.promoted}`);
      } else {
        console.log(`\nDry run — ${plan.decisions.length} classified, ${plan.decisions.filter((d) => d.promote).length} would promote. Re-run with --execute to apply.`);
      }
      return 0;
    } catch (error) {
      const code = error instanceof JazzbandError ? error.code : "error";
      console.error(JSON.stringify({ ok: false, code, message: (error as Error).message }, null, 2));
      return 1;
    }
  }

  if (command === "run") {
    const workflowPath = resolve(stringFlag(flags, "workflow") ?? "WORKFLOW.md");
    try {
      const workflow = loadWorkflow(workflowPath);
      const config = resolveConfig(workflow.config, { workflowDir: dirname(workflowPath) });
      const client = new LinearClient(config.tracker);

      if (!flags.execute) {
        const runtime = new Runtime({ config, source: client, worker: async () => ({ ok: true }), now: () => Date.now() });
        const dispatch = runtime.planDispatch(await client.fetchCandidateIssues());
        for (const issue of dispatch) console.log(`would work ${issue.identifier} (${issue.state})`);
        console.log(`\nDry run — ${dispatch.length} triage:fixable issue(s) would be worked. Re-run with --execute to launch Claude agents.`);
        return 0;
      }

      const worker = async (issue: Issue) => {
        let ok = false;
        await makeAgentDispatcher({
          config,
          promptTemplate: workflow.promptTemplate,
          makeClient: () => new ClaudeAgentClient({ turnTimeoutMs: config.codex.turnTimeoutMs }),
          onOutcome: (_issue, outcome) => {
            ok = outcome.ok;
          },
        })(issue);
        return { ok };
      };

      await runDelivery(
        { config, source: client, worker, now: () => Date.now(), log: (m) => console.error(m) },
        { once: Boolean(flags.once) },
      );
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    },
  );
}
