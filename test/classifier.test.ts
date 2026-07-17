import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicClassifier, type RunMessage } from "../src/triage/anthropicClassifier.js";
import type { Issue } from "../src/core/types.js";

function issue(): Issue {
  return {
    id: "iss_1",
    identifier: "IN-1977",
    title: "cant pick role up to 3",
    description: "It says pick up to 3 but I can only choose one.",
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

test("classifier forces the classify tool and maps its input to a Classification", async () => {
  let sentParams: Record<string, unknown> | null = null;
  const runMessage: RunMessage = async (params) => {
    sentParams = params;
    return {
      content: [
        {
          type: "tool_use",
          name: "classify",
          input: {
            verdict: "fixable",
            fingerprint: "role-picker",
            risk: "normal",
            surface: "portal:webapp",
            fixArea: "ProfessionalRoleForm.tsx",
            reason: "multiselect capped at 1",
          },
        },
      ],
    };
  };

  const classification = await new AnthropicClassifier({ runMessage }).classify(issue());

  assert.equal(classification.issueId, "iss_1");
  assert.equal(classification.verdict, "fixable");
  assert.equal(classification.surface, "portal:webapp");
  // Structured output is forced via a single tool call.
  assert.deepEqual(sentParams!.tool_choice, { type: "tool", name: "classify" });
  assert.equal(sentParams!.model, "claude-opus-4-8");
});

test("classifier errors when the model returns no structured verdict", async () => {
  const runMessage: RunMessage = async () => ({ content: [{ type: "text" }] });
  await assert.rejects(new AnthropicClassifier({ runMessage }).classify(issue()), /no structured verdict/);
});
