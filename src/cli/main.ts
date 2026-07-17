#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, validateDispatchPreflight } from "../core/config.js";
import { JazzbandError } from "../core/errors.js";
import { createWorkflowPlan } from "../core/planner.js";
import { loadWorkflow } from "../core/workflow.js";
import { LinearClient } from "../linear/client.js";
import { runLoop } from "../runtime/loop.js";

const USAGE = `Jazzband — TypeScript orchestration for ticket-driven agent workflows

Usage:
  jazzband check [--workflow <path>]
  jazzband poll [--workflow <path>] [--once]
  jazzband plan --ticket <KEY> --repo <owner/repo>
  jazzband run --ticket <KEY> --repo <owner/repo> [--execute]
  jazzband status --pr <url|owner/repo#N>
  jazzband --help

Commands:
  check    Load a WORKFLOW.md, resolve config, and run dispatch preflight. No side effects.
  poll     Poll the tracker and print the dispatch decision. --once runs one tick and exits.
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

  if (command === "plan" || command === "run") {
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
