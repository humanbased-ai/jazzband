import assert from "node:assert/strict";
import { test } from "node:test";
import { dedup } from "../src/triage/dedup.js";
import { planTriage } from "../src/triage/engine.js";
import type { Classification, Classifier } from "../src/triage/types.js";
import type { Issue } from "../src/core/types.js";

function issue(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: identifier,
    description: null,
    priority: null,
    state: "Backlog",
    branchName: null,
    url: null,
    prNumber: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
  };
}

/** Classifier keyed by issue id returning preset verdicts (mirrors the earlier live dry-run). */
function fakeClassifier(map: Record<string, Partial<Classification>>): Classifier {
  return {
    async classify(i) {
      const preset = map[i.id] ?? {};
      return {
        issueId: i.id,
        verdict: preset.verdict ?? "needs_confirmation",
        fingerprint: preset.fingerprint ?? i.id,
        risk: preset.risk ?? "normal",
        surface: preset.surface ?? "",
        fixArea: preset.fixArea ?? "",
        reason: preset.reason ?? "",
      };
    },
  };
}

test("dedup collapses shared fingerprints to the first (canonical) id", () => {
  const { duplicateOf } = dedup([
    { id: "a", fingerprint: "list-limited" },
    { id: "b", fingerprint: "list-limited" },
    { id: "c", fingerprint: "role-picker" },
  ]);
  assert.equal(duplicateOf.get("b"), "a");
  assert.equal(duplicateOf.has("a"), false);
  assert.equal(duplicateOf.has("c"), false);
});

test("planTriage labels, dedups, and promotes only safe fixable issues", async () => {
  const issues = [
    issue("u", "IN-1975"),
    issue("c", "IN-1976"),
    issue("r", "IN-1977"),
    issue("k", "IN-1981"),
    issue("p", "IN-2007"),
  ];
  const classifier = fakeClassifier({
    u: { verdict: "needs_confirmation", fingerprint: "list-limited", surface: "portal:webapp" },
    c: { verdict: "needs_confirmation", fingerprint: "list-limited", surface: "portal:webapp" },
    r: { verdict: "fixable", fingerprint: "role-picker", surface: "portal:webapp", fixArea: "ProfessionalRoleForm.tsx" },
    k: { verdict: "dangerous", fingerprint: "kyc-provider", surface: "portal:api", risk: "critical" },
    p: { verdict: "unimportant", fingerprint: "praise" },
  });

  const { decisions } = await planTriage(issues, classifier);
  const byId = new Map(decisions.map((d) => [d.issue.id, d]));

  // IN-1976 collapses into IN-1975 (same fingerprint); canonical keeps its own verdict.
  assert.equal(byId.get("c")?.verdict, "duplicate");
  assert.equal(byId.get("c")?.duplicateOf, "IN-1975");
  assert.equal(byId.get("c")?.promote, false);
  assert.equal(byId.get("u")?.verdict, "needs_confirmation");

  // Only the fixable, non-duplicate issue is promoted.
  assert.equal(byId.get("r")?.promote, true);
  assert.deepEqual(byId.get("r")?.labels, ["triage:fixable", "portal:webapp"]);

  // Dangerous is never promoted and carries risk + security labels.
  assert.equal(byId.get("k")?.promote, false);
  assert.deepEqual(byId.get("k")?.labels, ["triage:dangerous", "portal:api", "risk:critical", "security"]);

  // No promotions leak from unimportant.
  assert.equal(byId.get("p")?.promote, false);
  assert.equal(decisions.filter((d) => d.promote).length, 1);
});
