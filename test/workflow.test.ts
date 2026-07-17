import assert from "node:assert/strict";
import { test } from "node:test";
import { JazzbandError } from "../src/core/errors.js";
import { parseWorkflow } from "../src/core/workflow.js";

test("parses front matter into config and trims the prompt body", () => {
  const wf = parseWorkflow(
    ["---", "tracker:", "  kind: linear", "  project_slug: bugs", "---", "", "Fix the issue.", ""].join(
      "\n",
    ),
  );

  assert.deepEqual(wf.config, { tracker: { kind: "linear", project_slug: "bugs" } });
  assert.equal(wf.promptTemplate, "Fix the issue.");
});

test("treats a file with no front matter as an all-prompt body with empty config", () => {
  const wf = parseWorkflow("You are working on an issue.\n");
  assert.deepEqual(wf.config, {});
  assert.equal(wf.promptTemplate, "You are working on an issue.");
});

test("rejects front matter that does not decode to a map", () => {
  assert.throws(
    () => parseWorkflow(["---", "- just", "- a", "- list", "---", "body"].join("\n")),
    (error: unknown) =>
      error instanceof JazzbandError && error.code === "workflow_front_matter_not_a_map",
  );
});

test("rejects front matter that is opened but never closed", () => {
  assert.throws(
    () => parseWorkflow(["---", "tracker:", "  kind: linear"].join("\n")),
    (error: unknown) => error instanceof JazzbandError && error.code === "workflow_parse_error",
  );
});

test("empty front matter block yields an empty config", () => {
  const wf = parseWorkflow(["---", "---", "prompt"].join("\n"));
  assert.deepEqual(wf.config, {});
  assert.equal(wf.promptTemplate, "prompt");
});
