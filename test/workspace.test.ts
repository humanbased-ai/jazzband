import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertInsideRoot,
  assertLaunchCwd,
  prepareWorkspace,
  removeWorkspace,
  workspacePathFor,
  WorkspaceError,
  type HookRunner,
} from "../src/core/workspace.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "jz-ws-"));
}

const okHook: HookRunner = async () => ({ ok: true, code: 0, timedOut: false });
const failHook: HookRunner = async () => ({ ok: false, code: 1, timedOut: false });

test("workspacePathFor sanitizes the identifier into a single dir under root", () => {
  const root = "/tmp/ws";
  assert.equal(workspacePathFor(root, "IN-123"), resolve(root, "IN-123"));
  assert.equal(workspacePathFor(root, "team/../etc issue"), resolve(root, "team_.._etc_issue"));
});

test("assertInsideRoot rejects paths that escape the root", () => {
  assert.doesNotThrow(() => assertInsideRoot("/tmp/ws", "/tmp/ws/IN-1"));
  assert.throws(
    () => assertInsideRoot("/tmp/ws", "/tmp/other"),
    (e: unknown) => e instanceof WorkspaceError && e.code === "workspace_outside_root",
  );
});

test("assertLaunchCwd enforces cwd == workspace path", () => {
  assert.doesNotThrow(() => assertLaunchCwd("/tmp/ws/IN-1", "/tmp/ws/IN-1"));
  assert.throws(() => assertLaunchCwd("/tmp/ws", "/tmp/ws/IN-1"), WorkspaceError);
});

test("prepareWorkspace creates once then reuses (createdNow flips to false)", async () => {
  const root = freshRoot();
  const first = await prepareWorkspace({ root, identifier: "IN-1", hookTimeoutMs: 1000 });
  assert.equal(first.createdNow, true);
  assert.ok(existsSync(first.path));

  const second = await prepareWorkspace({ root, identifier: "IN-1", hookTimeoutMs: 1000 });
  assert.equal(second.createdNow, false);
  assert.equal(second.path, first.path);
});

test("after_create runs only on creation; its failure is fatal and removes the dir", async () => {
  const root = freshRoot();

  const created = await prepareWorkspace({
    root,
    identifier: "IN-2",
    afterCreate: "echo hi",
    hookTimeoutMs: 1000,
    hookRunner: okHook,
  });
  assert.ok(existsSync(created.path));

  const root2 = freshRoot();
  await assert.rejects(
    prepareWorkspace({
      root: root2,
      identifier: "IN-3",
      afterCreate: "exit 1",
      hookTimeoutMs: 1000,
      hookRunner: failHook,
    }),
    (e: unknown) => e instanceof WorkspaceError && e.code === "after_create_hook_failed",
  );
  assert.equal(existsSync(resolve(root2, "IN-3")), false); // partial dir removed
});

test("real bash hook runs with the workspace as cwd", async () => {
  const root = freshRoot();
  const ws = await prepareWorkspace({
    root,
    identifier: "IN-4",
    afterCreate: "pwd > marker.txt",
    hookTimeoutMs: 5000,
  });
  // `pwd` prints the realpath; on macOS /tmp is a symlink to /private/tmp.
  assert.equal(readFileSync(join(ws.path, "marker.txt"), "utf8").trim(), realpathSync(ws.path));
});

test("removeWorkspace deletes inside root and refuses outside root", async () => {
  const root = freshRoot();
  const ws = await prepareWorkspace({ root, identifier: "IN-5", hookTimeoutMs: 1000 });
  await removeWorkspace({ root, path: ws.path, hookTimeoutMs: 1000 });
  assert.equal(existsSync(ws.path), false);

  await assert.rejects(
    removeWorkspace({ root, path: "/tmp/somewhere-else", hookTimeoutMs: 1000 }),
    WorkspaceError,
  );
});
