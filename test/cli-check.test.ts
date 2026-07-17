import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli/main.js";

function workflowFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "jz-cli-"));
  const path = join(dir, "WORKFLOW.md");
  writeFileSync(path, body);
  return path;
}

test("check returns 0 for a valid linear workflow", async () => {
  const path = workflowFile(
    ["---", "tracker:", "  kind: linear", "  api_key: lin_api_1", "  project_slug: bugs", "---", "Do it."].join(
      "\n",
    ),
  );
  const code = await main(["check", "--workflow", path]);
  assert.equal(code, 0);
});

test("check returns 1 when preflight fails (missing project slug)", async () => {
  const path = workflowFile(
    ["---", "tracker:", "  kind: linear", "  api_key: lin_api_1", "---", "Do it."].join("\n"),
  );
  const code = await main(["check", "--workflow", path]);
  assert.equal(code, 1);
});

test("check returns 1 for a missing workflow file", async () => {
  const code = await main(["check", "--workflow", "/no/such/WORKFLOW.md"]);
  assert.equal(code, 1);
});
