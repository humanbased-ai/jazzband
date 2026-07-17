// Optional client-side `linear_graphql` tool exposed to the coding-agent session (SPEC §10.5).
// Executes exactly one GraphQL operation against Linear using the runtime's configured auth.

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/** Runs one GraphQL document, returning the transport status and decoded body. */
export type GraphqlExecutor = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<{ status: number; body: unknown }>;

interface ParsedInput {
  query: string;
  variables: Record<string, unknown>;
}

const OPERATION = /\b(query|mutation|subscription)\b\s*[A-Za-z_({]/g;

/** Count top-level GraphQL operations; an anonymous `{ ... }` selection counts as one query. */
function countOperations(query: string): number {
  const named = query.match(OPERATION)?.length ?? 0;
  if (named > 0) return named;
  return query.trim().startsWith("{") ? 1 : 0;
}

/** Accept the preferred `{query, variables}` object or a raw query string shorthand (§10.5). */
export function parseToolInput(raw: unknown): ParsedInput | { error: string } {
  if (typeof raw === "string") {
    return validate(raw, {});
  }
  if (typeof raw === "object" && raw !== null) {
    const { query, variables } = raw as Record<string, unknown>;
    if (typeof query !== "string") return { error: "query must be a string" };
    if (variables !== undefined && (typeof variables !== "object" || variables === null || Array.isArray(variables))) {
      return { error: "variables must be a JSON object" };
    }
    return validate(query, (variables as Record<string, unknown>) ?? {});
  }
  return { error: "input must be a query string or a {query, variables} object" };
}

function validate(query: string, variables: Record<string, unknown>): ParsedInput | { error: string } {
  if (query.trim() === "") return { error: "query must be a non-empty string" };
  const ops = countOperations(query);
  if (ops === 0) return { error: "query must contain a GraphQL operation" };
  if (ops > 1) return { error: "query must contain exactly one GraphQL operation" };
  return { query, variables };
}

/**
 * Execute the tool (SPEC §10.5 result semantics):
 * - transport ok + no top-level `errors` → success
 * - GraphQL `errors` present → not success, but keep the body for debugging
 * - invalid input / transport failure → not success with an error payload
 */
export async function runLinearGraphqlTool(raw: unknown, execute: GraphqlExecutor): Promise<ToolResult> {
  const parsed = parseToolInput(raw);
  if ("error" in parsed) return { success: false, error: parsed.error };

  let response: { status: number; body: unknown };
  try {
    response = await execute(parsed.query, parsed.variables);
  } catch (error) {
    return { success: false, error: `transport failure: ${(error as Error).message}` };
  }

  if (response.status !== 200) {
    return { success: false, error: `status ${response.status}`, data: response.body };
  }
  const body = response.body;
  const hasErrors =
    typeof body === "object" && body !== null && "errors" in (body as Record<string, unknown>);
  return { success: !hasErrors, data: body };
}
