import { Liquid } from "liquidjs";
import { JazzbandError } from "./errors.js";
import { DEFAULT_PROMPT } from "./workflow.js";
import type { Issue } from "./types.js";

// Strict variable + filter checking: unknown variables/filters MUST fail rendering (SPEC §5.4, §12.2).
const engine = new Liquid({ strictVariables: true, strictFilters: true });

export interface PromptContext {
  issue: Issue;
  /** null/absent on first attempt; integer on retry or continuation (SPEC §12.3). */
  attempt?: number | null;
}

/**
 * Render the workflow prompt template (SPEC §5.4, §12). An empty template falls back to the
 * minimal default prompt. Parse failures raise `template_parse_error`; unknown variables/filters
 * or bad interpolation raise `template_render_error` (SPEC §5.5, §12.4).
 */
export function renderPrompt(template: string, context: PromptContext): string {
  const body = template.trim();
  if (body === "") return DEFAULT_PROMPT;

  let parsed;
  try {
    parsed = engine.parse(body);
  } catch (error) {
    throw new JazzbandError("template_parse_error", (error as Error).message);
  }

  try {
    return engine.renderSync(parsed, { issue: context.issue, attempt: context.attempt ?? null });
  } catch (error) {
    throw new JazzbandError("template_render_error", (error as Error).message);
  }
}
