import assert from "node:assert/strict";
import { test } from "node:test";
import { JazzbandError } from "../src/core/errors.js";
import { renderPrompt } from "../src/core/prompt.js";
import type { Issue } from "../src/core/types.js";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "iss",
    identifier: "IN-1",
    title: "Fix the widget",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    prNumber: null,
    labels: ["bug", "portal:webapp"],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

test("renders issue fields and iterates nested arrays", () => {
  const out = renderPrompt(
    "Work on {{ issue.identifier }}: {{ issue.title }}\nLabels:{% for l in issue.labels %} {{ l }}{% endfor %}",
    { issue: issue() },
  );
  assert.equal(out, "Work on IN-1: Fix the widget\nLabels: bug portal:webapp");
});

test("passes attempt through for retry/continuation branching", () => {
  const template = "{% if attempt %}Retry {{ attempt }}{% else %}First run{% endif %}";
  assert.equal(renderPrompt(template, { issue: issue() }), "First run");
  assert.equal(renderPrompt(template, { issue: issue(), attempt: 2 }), "Retry 2");
});

test("empty template falls back to the default prompt", () => {
  assert.equal(renderPrompt("   \n  ", { issue: issue() }), "You are working on an issue from Linear.");
});

test("unknown variables fail rendering (strict)", () => {
  assert.throws(
    () => renderPrompt("{{ issue.nonexistent_field }}", { issue: issue() }),
    (e: unknown) => e instanceof JazzbandError && e.code === "template_render_error",
  );
});
