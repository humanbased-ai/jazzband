import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { JazzbandError } from "./errors.js";
import type { RawConfig, WorkflowDefinition } from "./types.js";

/** Minimal default prompt when the workflow body is empty (SPEC §5.4). */
export const DEFAULT_PROMPT = "You are working on an issue from Linear.";

/**
 * Parse WORKFLOW.md text into { config, promptTemplate } (SPEC §5.2).
 *
 * - If the file starts with `---`, everything up to the next `---` line is YAML front matter.
 * - Front matter MUST decode to a map/object; anything else is an error.
 * - The remaining body is the prompt template, trimmed.
 * - With no front matter, the whole file is the prompt body and config is `{}`.
 */
export function parseWorkflow(text: string): WorkflowDefinition {
  const normalized = text.replace(/\r\n/g, "\n");
  let config: RawConfig = {};
  let body = normalized;

  const lines = normalized.split("\n");
  if (lines[0]?.trim() === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") {
        end = i;
        break;
      }
    }
    if (end === -1) {
      throw new JazzbandError(
        "workflow_parse_error",
        "front matter opened with '---' but no closing '---' was found",
      );
    }

    const frontMatter = lines.slice(1, end).join("\n");
    let decoded: unknown;
    try {
      decoded = parseYaml(frontMatter);
    } catch (error) {
      throw new JazzbandError(
        "workflow_parse_error",
        `front matter YAML failed to parse: ${(error as Error).message}`,
      );
    }

    if (decoded === null || decoded === undefined) {
      decoded = {};
    }
    if (typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new JazzbandError(
        "workflow_front_matter_not_a_map",
        "front matter must decode to a map/object",
      );
    }
    config = decoded as RawConfig;
    body = lines.slice(end + 1).join("\n");
  }

  return { config, promptTemplate: body.trim() };
}

/** Load and parse a WORKFLOW.md file (SPEC §5.1). */
export function loadWorkflow(path: string): WorkflowDefinition {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new JazzbandError("missing_workflow_file", `cannot read workflow file: ${path}`);
  }
  return parseWorkflow(text);
}
