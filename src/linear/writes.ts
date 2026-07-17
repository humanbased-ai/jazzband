import { fetchTransport, NETWORK_TIMEOUT_MS, type Transport } from "./client.js";
import { LinearError } from "./errors.js";
import type { TrackerConfig } from "../core/types.js";

type Json = Record<string, unknown>;

function nested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Json)[key];
  }
  return current;
}

const TEAM_ID_QUERY = `query($slug: String!) { projects(filter: {slugId: {eq: $slug}}) { nodes { teams { nodes { id } } } } }`;
const TEAM_LABELS_QUERY = `query($teamId: String!) { team(id: $teamId) { labels { nodes { id name } } } }`;
const WORKFLOW_STATES_QUERY = `query($teamId: ID!) { workflowStates(filter: {team: {id: {eq: $teamId}}}) { nodes { id name } } }`;
const LABEL_CREATE = `mutation($name: String!, $teamId: String!) { issueLabelCreate(input: {name: $name, teamId: $teamId}) { success issueLabel { id } } }`;
const ISSUE_ADD_LABEL = `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`;
const COMMENT_CREATE = `mutation($issueId: String!, $body: String!) { commentCreate(input: {issueId: $issueId, body: $body}) { success } }`;
const ISSUE_UPDATE = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`;

export interface LinearWriteOptions {
  transport?: Transport;
}

/** Linear write operations used by the triage executor. Reads/writes share the injectable transport. */
export class LinearWriteClient {
  private readonly tracker: TrackerConfig;
  private readonly transport: Transport;
  private teamId: string | null = null;
  private readonly labelCache = new Map<string, string>();
  private readonly stateCache = new Map<string, string>();

  constructor(tracker: TrackerConfig, options: LinearWriteOptions = {}) {
    this.tracker = tracker;
    this.transport = options.transport ?? fetchTransport;
  }

  async resolveTeamId(): Promise<string> {
    if (this.teamId) return this.teamId;
    if (!this.tracker.projectSlug) {
      throw new LinearError("missing_tracker_project_slug", "missing_tracker_project_slug");
    }
    const body = await this.graphql(TEAM_ID_QUERY, { slug: this.tracker.projectSlug });
    const teamId = nested(body, "data", "projects", "nodes", "0", "teams", "nodes", "0", "id");
    if (typeof teamId !== "string") {
      throw new LinearError("linear_unknown_payload", `no team for project ${this.tracker.projectSlug}`);
    }
    this.teamId = teamId;
    return teamId;
  }

  /** Return the label id for `name`, creating the team label if it does not exist. */
  async ensureLabelId(name: string): Promise<string> {
    if (this.labelCache.has(name)) return this.labelCache.get(name)!;
    const teamId = await this.resolveTeamId();

    const listed = await this.graphql(TEAM_LABELS_QUERY, { teamId });
    const nodes = nested(listed, "data", "team", "labels", "nodes");
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (typeof node === "object" && node !== null && (node as Json).name === name) {
          const id = (node as Json).id;
          if (typeof id === "string") {
            this.labelCache.set(name, id);
            return id;
          }
        }
      }
    }

    const created = await this.graphql(LABEL_CREATE, { name, teamId });
    const id = nested(created, "data", "issueLabelCreate", "issueLabel", "id");
    if (typeof id !== "string") throw new LinearError("linear_unknown_payload", `label create failed: ${name}`);
    this.labelCache.set(name, id);
    return id;
  }

  async addLabel(issueId: string, name: string): Promise<void> {
    const labelId = await this.ensureLabelId(name);
    await this.graphql(ISSUE_ADD_LABEL, { id: issueId, labelId });
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.graphql(COMMENT_CREATE, { issueId, body });
  }

  async resolveStateId(name: string): Promise<string> {
    if (this.stateCache.has(name)) return this.stateCache.get(name)!;
    const teamId = await this.resolveTeamId();
    const body = await this.graphql(WORKFLOW_STATES_QUERY, { teamId });
    const nodes = nested(body, "data", "workflowStates", "nodes");
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (typeof node === "object" && node !== null && (node as Json).name === name) {
          const id = (node as Json).id;
          if (typeof id === "string") {
            this.stateCache.set(name, id);
            return id;
          }
        }
      }
    }
    throw new LinearError("linear_unknown_payload", `state not found: ${name}`);
  }

  async updateIssue(issueId: string, input: { title?: string; stateId?: string; projectId?: string }): Promise<void> {
    await this.graphql(ISSUE_UPDATE, { id: issueId, input });
  }

  private async graphql(query: string, variables: Json): Promise<unknown> {
    if (!this.tracker.apiKey) {
      throw new LinearError("missing_tracker_api_key", "missing_tracker_api_key");
    }
    let response;
    try {
      response = await this.transport(
        this.tracker.endpoint,
        { query, variables },
        { Authorization: this.tracker.apiKey, "Content-Type": "application/json" },
        NETWORK_TIMEOUT_MS,
      );
    } catch (error) {
      throw new LinearError("linear_api_request", (error as Error).message);
    }
    if (response.status !== 200) throw new LinearError("linear_api_status", `status=${response.status}`);
    if (typeof response.body !== "object" || response.body === null) {
      throw new LinearError("linear_unknown_payload", "linear_unknown_payload");
    }
    if ("errors" in (response.body as Json)) {
      throw new LinearError("linear_graphql_errors", JSON.stringify((response.body as Json).errors));
    }
    return response.body;
  }
}
