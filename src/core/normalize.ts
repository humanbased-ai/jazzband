// Stable identifier and normalization rules (SPEC §4.2).

/** Derive the workspace directory name from an issue identifier. */
export function workspaceKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Issue states are compared after lowercasing. */
export function normalizeState(state: string): string {
  return state.toLowerCase();
}

/** Compose a coding-agent session id from its thread and turn ids. */
export function sessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}
