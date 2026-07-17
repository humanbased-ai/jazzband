import { LinearError } from "./errors.js";
import type { BlockerRef, Issue } from "../core/types.js";

type Raw = Record<string, unknown>;

function nested(value: unknown, ...keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Raw)[key];
  }
  return current;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value === "string" && value !== "") return value;
  throw new LinearError("linear_unknown_payload", `missing_issue_field:${field}`);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Priority is an integer only; booleans and non-integers become null (SPEC §11.3). */
function priority(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Timestamps are kept as ISO-8601 strings; unparseable values become null (SPEC §11.3). */
function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function labels(raw: Raw): string[] {
  const nodes = nested(raw, "labels", "nodes");
  if (!Array.isArray(nodes)) return [];
  const out: string[] = [];
  for (const node of nodes) {
    const name = typeof node === "object" && node !== null ? (node as Raw).name : undefined;
    if (typeof name === "string") out.push(name.toLowerCase());
  }
  return out;
}

/** Blockers derive from inverse relations whose type is `blocks` (SPEC §11.3). */
function blockers(raw: Raw): BlockerRef[] {
  const nodes = nested(raw, "inverseRelations", "nodes");
  if (!Array.isArray(nodes)) return [];
  const out: BlockerRef[] = [];
  for (const relation of nodes) {
    if (typeof relation !== "object" || relation === null) continue;
    const relationType = (relation as Raw).type;
    const issue = (relation as Raw).issue;
    if (typeof relationType !== "string" || typeof issue !== "object" || issue === null) continue;
    if (relationType.trim().toLowerCase() !== "blocks") continue;
    out.push({
      id: optionalString((issue as Raw).id),
      identifier: optionalString((issue as Raw).identifier),
      state: optionalString(nested(issue, "state", "name")),
    });
  }
  return out;
}

const PR_URL = /\/pull\/(\d+)$/;

function prNumber(raw: Raw): number | null {
  const nodes = nested(raw, "attachments", "nodes");
  if (!Array.isArray(nodes)) return null;
  for (const node of nodes) {
    const url = typeof node === "object" && node !== null ? (node as Raw).url : undefined;
    if (typeof url !== "string") continue;
    const match = PR_URL.exec(url);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Normalize a raw Linear issue node into the domain Issue (SPEC §4.1.1, §11.3). */
export function normalizeIssue(raw: Raw): Issue {
  return {
    id: requiredString(raw.id, "id"),
    identifier: requiredString(raw.identifier, "identifier"),
    title: requiredString(raw.title, "title"),
    description: optionalString(raw.description),
    priority: priority(raw.priority),
    state: requiredString(nested(raw, "state", "name"), "state.name"),
    branchName: optionalString(raw.branchName),
    url: optionalString(raw.url),
    prNumber: prNumber(raw),
    labels: labels(raw),
    blockedBy: blockers(raw),
    createdAt: timestamp(raw.createdAt),
    updatedAt: timestamp(raw.updatedAt),
  };
}
