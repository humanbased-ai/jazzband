import { LinearError } from "./errors.js";
import { normalizeIssue } from "./normalize.js";
import { CANDIDATE_ISSUES_QUERY, ISSUES_BY_ID_QUERY } from "./queries.js";
import type { Issue, TrackerConfig } from "../core/types.js";

export const ISSUE_PAGE_SIZE = 50;
export const NETWORK_TIMEOUT_MS = 30000;

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

/** Transport seam so the HTTP layer can be swapped in tests. */
export type Transport = (
  url: string,
  payload: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<GraphQLResponse>;

export interface LinearClientOptions {
  transport?: Transport;
}

type Json = Record<string, unknown>;

function nested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Json)[key];
  }
  return current;
}

/** Default transport over global fetch with a hard network timeout (SPEC §11.2). */
export const fetchTransport: Transport = async (url, payload, headers, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
};

export class LinearClient {
  private readonly tracker: TrackerConfig;
  private readonly transport: Transport;

  constructor(tracker: TrackerConfig, options: LinearClientOptions = {}) {
    this.tracker = tracker;
    this.transport = options.transport ?? fetchTransport;
  }

  /** Issues in the configured active states for the configured project (SPEC §11.1). */
  async fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.tracker.activeStates);
  }

  /** Paginated fetch of issues in the given states (SPEC §11.1–11.2). */
  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    const states = [...new Set(stateNames.map((s) => String(s)).filter((s) => s.trim() !== ""))];
    if (states.length === 0) return [];
    if (!this.tracker.projectSlug) {
      throw new LinearError("missing_tracker_project_slug", "missing_tracker_project_slug");
    }

    const issues: Issue[] = [];
    let after: string | null = null;

    for (;;) {
      const body = await this.graphql(CANDIDATE_ISSUES_QUERY, {
        projectSlug: this.tracker.projectSlug,
        stateNames: states,
        first: ISSUE_PAGE_SIZE,
        relationFirst: ISSUE_PAGE_SIZE,
        after,
      });

      const page = nested(body, "data", "issues");
      const nodes = nested(page, "nodes");
      const pageInfo = nested(page, "pageInfo");
      if (!Array.isArray(nodes) || typeof pageInfo !== "object" || pageInfo === null) {
        throw new LinearError("linear_unknown_payload", "linear_unknown_payload");
      }
      for (const node of nodes) issues.push(normalizeIssue(node as Json));

      if ((pageInfo as Json).hasNextPage === true) {
        const cursor = (pageInfo as Json).endCursor;
        if (typeof cursor !== "string" || cursor === "") {
          throw new LinearError("linear_missing_end_cursor", "linear_missing_end_cursor");
        }
        after = cursor;
        continue;
      }
      return issues;
    }
  }

  /** Refresh issue state by GraphQL id, batched and returned in request order (SPEC §11.1). */
  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    const ids = [...new Set(issueIds)];
    if (ids.length === 0) return [];

    const issues: Issue[] = [];
    for (let offset = 0; offset < ids.length; offset += ISSUE_PAGE_SIZE) {
      const batch = ids.slice(offset, offset + ISSUE_PAGE_SIZE);
      const body = await this.graphql(ISSUES_BY_ID_QUERY, {
        ids: batch,
        first: batch.length,
        relationFirst: ISSUE_PAGE_SIZE,
      });
      const nodes = nested(body, "data", "issues", "nodes");
      if (!Array.isArray(nodes)) {
        throw new LinearError("linear_unknown_payload", "linear_unknown_payload");
      }
      for (const node of nodes) issues.push(normalizeIssue(node as Json));
    }

    const order = new Map(ids.map((id, index) => [id, index]));
    return issues.sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length));
  }

  private async graphql(query: string, variables: Json): Promise<unknown> {
    if (!this.tracker.apiKey) {
      throw new LinearError("missing_tracker_api_key", "missing_tracker_api_key");
    }
    const headers = {
      Authorization: this.tracker.apiKey,
      "Content-Type": "application/json",
    };

    let response: GraphQLResponse;
    try {
      response = await this.transport(
        this.tracker.endpoint,
        { query, variables },
        headers,
        NETWORK_TIMEOUT_MS,
      );
    } catch (error) {
      throw new LinearError("linear_api_request", (error as Error).message);
    }

    if (response.status !== 200) {
      throw new LinearError("linear_api_status", `status=${response.status}`);
    }
    if (typeof response.body !== "object" || response.body === null) {
      throw new LinearError("linear_unknown_payload", "linear_unknown_payload");
    }
    if ("errors" in (response.body as Json)) {
      throw new LinearError("linear_graphql_errors", JSON.stringify((response.body as Json).errors));
    }
    return response.body;
  }
}
