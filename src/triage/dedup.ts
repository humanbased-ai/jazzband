export interface Fingerprinted {
  id: string;
  fingerprint: string;
}

export interface DedupResult {
  /** Non-canonical issue id → the canonical id it duplicates. */
  duplicateOf: Map<string, string>;
}

/**
 * Collapse issues that share a fingerprint. The canonical of each group is the first entry in the
 * input order (callers pass issues oldest-first), and the rest are marked as its duplicates.
 */
export function dedup(items: Fingerprinted[]): DedupResult {
  const canonicalByFingerprint = new Map<string, string>();
  const duplicateOf = new Map<string, string>();

  for (const item of items) {
    const key = item.fingerprint.trim().toLowerCase();
    if (key === "") continue;
    const canonical = canonicalByFingerprint.get(key);
    if (canonical === undefined) {
      canonicalByFingerprint.set(key, item.id);
    } else {
      duplicateOf.set(item.id, canonical);
    }
  }

  return { duplicateOf };
}
